// Reading plumb's own session records for the e2e's assertions.
//
// plumb writes one JSON file per session under its data dir's `sessions/`. In
// the isolated-daemon mode that directory belongs to the scenario's private
// HOME, so every record in it is the scenario's. In namespace mode it is the one
// daemon's directory, shared by every scenario and every namespace, and a record
// is the scenario's only if it carries the scenario's namespace id. Both modes
// parse a record the same way; the namespace filter is the only difference, and
// it is a function of the record alone so it can be tested without a daemon.

import fs from 'node:fs'
import path from 'node:path'
import { walkDirs } from './isolated-daemon.mjs'

/** The client names the e2e's own processes connect under. */
export const E2E_CLIENT_NAMES = ['dsh-plumb-identity', 'dsh-mcp-client', 'dsh-identity-e2e-sender']

/**
 * One session record file's text as the fields the assertions use, or null for
 * text that is not a complete record (a half-written file is retried by the
 * next poll) or one that carries none of the fields the e2e looks at.
 *
 * `namespace` is the public id of the record's namespace, '' for the default
 * namespace (plumb omits the field there).
 */
export function parseSessionRecord(text, file = '') {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (record === null || typeof record !== 'object') return null
  const externalId = typeof record.external_id === 'string' ? record.external_id : null
  const purpose = typeof record.purpose === 'string' ? record.purpose : null
  // Who opened the connection. The plugin's per-agent clients name themselves
  // `dsh-plumb-identity`; the shared MCP row is `dsh-mcp-client`. This is what
  // distinguishes "one connection per agent" from "one shared connection
  // carrying a stamped identity" — the two designs produce the same declaration
  // count, only the client differs.
  const clientName = typeof record.client_name === 'string' ? record.client_name : null
  if (externalId === null && purpose === null && clientName === null) return null
  // A Go zero time is how plumb writes "not ended" (omitempty does not omit a
  // struct), so only a real timestamp counts as an end.
  const ended = typeof record.ended_at === 'string' && !record.ended_at.startsWith('0001-')
  const startedAt = typeof record.started_at === 'string' ? Date.parse(record.started_at) : Number.NaN
  return {
    file,
    id: typeof record.id === 'string' ? record.id : null,
    name: typeof record.name === 'string' ? record.name : null,
    ended,
    clientName,
    externalId,
    purpose,
    // Minted ids are `dsh-<workspace-slug>-<short>`; main-conversation shorts
    // carry a `-session-` segment, subagent shorts are a bare uuid fragment — so
    // match the minted shape, not either convention.
    isIdentity: /^dsh-[a-z0-9-]{12,}$/.test(externalId ?? ''),
    // plumb marks a connection carrying more than one logical agent here;
    // `declared-id` asserts the mark never appears (PLAN-510).
    health: typeof record.health === 'string' ? record.health : '',
    namespace: typeof record.namespace === 'string' ? record.namespace : '',
    startedAtMs: Number.isNaN(startedAt) ? null : startedAt,
  }
}

/**
 * Whether a directory entry is a session record plumb has finished writing.
 * plumb writes a record through an atomic temp file in this same directory
 * (TempPattern ".session-*.json.tmp", internal/session). Its own readers match
 * *.json; this one used to read every regular file, so a complete, fsynced temp
 * file caught before its rename parsed as a duplicate record — which failed
 * `per-agent` intermittently and, worse, could satisfy the "two own
 * connections" control in expectNoteSurvivedReconnect with ONE connection.
 */
export function isRecordFile(name) {
  return name.endsWith('.json') && !name.startsWith('.')
}

/** Every record in one `sessions` directory (none if it is not there yet). */
export function readRecordsIn(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw new Error(`cannot read the session directory ${dir}: ${error.code ?? error.message}`)
  }
  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !isRecordFile(entry.name)) continue
    const file = path.join(dir, entry.name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      // Pruned between the listing and the read.
      if (error.code === 'ENOENT') continue
      throw new Error(`cannot read the session record ${file}: ${error.code ?? error.message}`)
    }
    const record = parseSessionRecord(text, file)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * Every record under an isolated plumb HOME. The sessions directory's exact
 * parent differs by platform/XDG resolution, so it is located by walking the
 * private HOME.
 */
export function readRecordsUnder(plumbHome) {
  if (!fs.existsSync(plumbHome)) return []
  return walkDirs(plumbHome, 0)
    .filter((dir) => path.basename(dir) === 'sessions')
    .flatMap((dir) => readRecordsIn(dir))
}

/**
 * The records of namespace `id`. An empty or non-string id would select the
 * DEFAULT namespace's records (whose `namespace` is ''), which is exactly the
 * mix-up namespace mode exists to prevent, so it throws instead.
 */
export function inNamespace(records, id) {
  if (typeof id !== 'string' || id === '') throw new Error('a namespace id is required to select a namespace\'s records')
  return records.filter((record) => record.namespace === id)
}

/**
 * Records that belong to this e2e but sit OUTSIDE namespace `id`: made by one of
 * the e2e's own clients since `sinceMs`, in any other namespace (the default
 * included). A serve that lacked the scenario's token lands here, joined to the
 * default namespace, where no assertion on the scenario's own records would ever
 * look. `sinceMs` keeps a daemon's older, unrelated sessions out of the verdict.
 */
export function strayRecords(records, id, sinceMs) {
  return records.filter((record) => (
    record.namespace !== id
    && record.clientName !== null
    && E2E_CLIENT_NAMES.includes(record.clientName)
    && record.startedAtMs !== null
    && record.startedAtMs >= sinceMs
  ))
}

/**
 * The lines of a shared daemon's log that belong to `sessionIds`. The daemon
 * tags every connection's lines `session_id=<id>`, which is the record's `id`,
 * so a scenario in a daemon it shares with others reads only its own lines. An
 * empty id list selects nothing: a scenario that has no sessions has no lines.
 */
export function logLinesForSessions(logText, sessionIds) {
  const ids = sessionIds.filter((id) => typeof id === 'string' && id !== '')
  if (ids.length === 0) return ''
  const wanted = new Set(ids)
  return logText
    .split('\n')
    .filter((line) => {
      const match = /\bsession_id=("?)([^\s"]+)\1(?=\s|$)/.exec(line)
      return match !== null && wanted.has(match[2])
    })
    .join('\n')
}
