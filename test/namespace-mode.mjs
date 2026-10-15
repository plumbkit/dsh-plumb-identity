// Namespace isolation for the e2e (PLAN-520, slice C).
//
// The e2e used to give every scenario a plumb daemon of its own, isolated by a
// private HOME. plumb now has namespaces: one daemon, and a private slice of it
// per run, so the suite needs no daemon of its own and a machine keeps exactly
// one. A scenario creates a namespace, every `plumb serve` it causes joins it
// through PLUMB_NAMESPACE, and it releases the namespace when it ends.
//
// What lives here is the part that can be tested without a daemon: choosing the
// isolation, probing whether the plumb in use has namespaces, the bookkeeping of
// the tokens a run holds (so every one of them is released however the run
// ends), the wrapper that gives a scenario's serves their token, and the
// session source a scenario reads its assertions from. It never starts, stops or
// signals a daemon: in namespace mode the daemon is somebody else's (the
// container runner starts it; see test/container/run.sh), and the one thing this
// does to it is create and release namespaces.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { inNamespace, logLinesForSessions, readRecordsIn, strayRecords } from './session-records.mjs'

export const ISOLATION_ENV = 'E2E_ISOLATION'
export const ISOLATION_MODES = ['namespace', 'daemon']
/**
 * Namespace unless asked otherwise. The alternative is never reached by
 * accident: a plumb without namespaces makes the default REFUSE (see
 * probeNamespaceSupport), and `daemon` has to be named.
 */
export const DEFAULT_ISOLATION = 'namespace'

/**
 * The isolation this run uses: `namespace` (one daemon, a namespace per
 * scenario) or `daemon` (a daemon per scenario under a private HOME, the
 * pre-PLAN-520 harness). Anything else is an error, never a quiet default.
 */
export function selectIsolation(env = process.env) {
  const raw = env[ISOLATION_ENV]
  if (raw === undefined || raw === '') return { mode: DEFAULT_ISOLATION, explicit: false }
  if (!ISOLATION_MODES.includes(raw)) {
    throw new Error(`${ISOLATION_ENV}=${JSON.stringify(raw)} is not an isolation: expected ${ISOLATION_MODES.map((m) => `"${m}"`).join(' or ')}`)
  }
  return { mode: raw, explicit: true }
}

// -- running plumb ------------------------------------------------------------------

/**
 * Run a plumb CLI command to completion. The ambient PLUMB_NAMESPACE is dropped
 * unless `env` names one: a runner that was itself started inside a namespace
 * must not create its scenarios' namespaces inside that one.
 */
export function runPlumb(plumbBin, args, { env = {}, timeoutMs = 20_000, spawn = spawnSync } = {}) {
  const base = { ...process.env }
  delete base.PLUMB_NAMESPACE
  const result = spawn(plumbBin, args, { encoding: 'utf8', timeout: timeoutMs, env: { ...base, ...env } })
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  }
}

/** A JSON document out of a command's stdout (anything before the first `{` or `[` is not part of it). */
export function parseJsonOutput(stdout) {
  const text = String(stdout).trim()
  const start = text.search(/[[{]|^null$/m)
  if (start < 0) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text.slice(start)) }
  } catch {
    return { ok: false }
  }
}

function firstLine(text) {
  const line = String(text).split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  return line === undefined ? '' : line.slice(0, 300)
}

function describeRun({ status, signal, stderr, stdout, error }) {
  if (error) return `could not run it: ${error.code ?? error.message}`
  if (signal) return `killed by ${signal}`
  return `exit ${status}${firstLine(stderr) || firstLine(stdout) ? `: ${firstLine(stderr) || firstLine(stdout)}` : ''}`
}

// -- the capability probe -------------------------------------------------------------

/**
 * Whether the plumb BINARY has a `plumb namespace` command, from the result of
 * `plumb namespace --help`. A build without it answers "unknown command" and
 * exits non-zero; one with it lists its four subcommands. Both are required, so
 * a binary that prints something else and exits 0 is not taken for a capable one.
 */
export function classifyBinaryProbe(result) {
  const out = `${result.stdout}\n${result.stderr}`
  if (result.error || result.status !== 0 || result.signal) {
    return { ok: false, kind: 'binary', detail: describeRun(result) }
  }
  const missing = ['create', 'renew', 'release', 'list'].filter((word) => !new RegExp(`\\b${word}\\b`).test(out))
  if (missing.length > 0) return { ok: false, kind: 'binary', detail: `\`plumb namespace --help\` does not list: ${missing.join(', ')}` }
  return { ok: true }
}

/**
 * Whether the RUNNING DAEMON answers namespace commands, from the result of
 * `plumb namespace list --json`: the namespaces it lists (an empty list prints
 * as `null`), or why it cannot. A daemon an older binary left running answers
 * with something that is not a namespace reply, which plumb reports as
 * "does not support namespaces".
 */
export function classifyDaemonProbe(result) {
  const out = `${result.stdout}\n${result.stderr}`
  if (result.error || result.signal) return { ok: false, kind: 'daemon-unreachable', detail: describeRun(result) }
  if (result.status !== 0) {
    if (/does not support namespaces/i.test(out)) return { ok: false, kind: 'daemon-old', detail: firstLine(out.replace(/^\s*Error:\s*/im, '')) }
    return { ok: false, kind: 'daemon-unreachable', detail: describeRun(result) }
  }
  const parsed = parseJsonOutput(result.stdout)
  if (!parsed.ok || !(parsed.value === null || Array.isArray(parsed.value))) {
    return { ok: false, kind: 'daemon-unreachable', detail: `\`plumb namespace list --json\` did not answer with a list: ${firstLine(result.stdout)}` }
  }
  return { ok: true, namespaces: parsed.value ?? [] }
}

const REFUSAL_REMEDY = {
  binary: 'This plumb build has no `plumb namespace` command. Build one with namespaces (plumb PR #686 or later).',
  'daemon-old': 'The plumb daemon that is running predates namespaces. Restart it from a build that has them.',
  'daemon-unreachable': 'No plumb daemon answered. Namespace mode runs inside ONE already-running daemon and never starts one itself (test/container/run.sh starts the container\'s).',
}

/**
 * The message for a failed probe. It states what is wrong, what to do, and that
 * the run did NOT fall back to a daemon per scenario: that is a different
 * isolation, chosen only by naming it.
 */
export function describeProbeFailure(probe) {
  return [
    `namespace isolation is unavailable: ${probe.detail}`,
    REFUSAL_REMEDY[probe.kind] ?? '',
    `Refusing to fall back to a daemon per scenario. To run that older isolation deliberately, set ${ISOLATION_ENV}=daemon.`,
  ].filter(Boolean).join('\n')
}

/**
 * Probe the plumb in use: the binary first (`namespace --help`, which touches no
 * daemon), then the daemon (`namespace list --json`). Resolves
 * `{ ok: true, namespaces }` or `{ ok: false, kind, detail }`. It runs only
 * namespace commands, so a failed probe has started nothing.
 */
export function probeNamespaceSupport(plumbBin, { run = runPlumb } = {}) {
  const binary = classifyBinaryProbe(run(plumbBin, ['namespace', '--help']))
  if (!binary.ok) return binary
  return classifyDaemonProbe(run(plumbBin, ['namespace', 'list', '--json']))
}

// -- tokens -----------------------------------------------------------------------------

/**
 * The namespaces one run holds. A token is recorded the moment `create` returns
 * it, before anything else can fail, and stays outstanding until its release is
 * confirmed, so `releaseAll` (the signal handler's and the exit hook's) always
 * knows what is left to release. Every method is synchronous: a process 'exit'
 * handler can run nothing else.
 *
 * A SIGKILL runs none of it. That is what `--owner-pid` is for: the namespace
 * expires five minutes after the runner is gone.
 */
export function createNamespaceLedger({ plumbBin, run = runPlumb, ownerPid = process.pid, ttl = '30m' }) {
  const held = new Map() // label -> { token, released }; the label is the namespace id when there is one
  let unlabelled = 0

  function create() {
    const result = run(plumbBin, ['namespace', 'create', '--ttl', ttl, '--owner-pid', String(ownerPid), '--json'])
    const parsed = result.status === 0 && !result.error ? parseJsonOutput(result.stdout) : { ok: false }
    if (!parsed.ok) throw new Error(`plumb namespace create failed: ${describeRun(result)}`)
    const token = parsed.value?.token
    const id = parsed.value?.namespace?.id
    // The id selects a scenario's records, and an empty one would select the
    // default namespace's: refuse anything that is not a namespace id. A token
    // that came back with a bad id is still recorded, so it is still released.
    const valid = typeof id === 'string' && /^ns-[A-Za-z0-9]+$/.test(id)
    if (typeof token === 'string' && token !== '') held.set(valid ? id : `unidentified-${++unlabelled}`, { token, released: false })
    if (!valid || typeof token !== 'string' || token === '') {
      throw new Error('plumb namespace create did not return a token and a namespace id (ns-...)')
    }
    return { id, token }
  }

  /** Release one namespace. Returns the problem, or null once it is confirmed revoked. */
  function release(label) {
    const entry = held.get(label)
    if (!entry) return `namespace ${label} was not created by this run`
    if (entry.released) return null
    const result = run(plumbBin, ['namespace', 'release', '--json'], { env: { PLUMB_NAMESPACE: entry.token } })
    const parsed = result.status === 0 && !result.error ? parseJsonOutput(result.stdout) : { ok: false }
    if (!parsed.ok) return `could not release namespace ${label}: ${describeRun(result)}`
    const state = parsed.value?.namespace?.state
    const replied = parsed.value?.namespace?.id
    if (state !== 'revoked' || (label.startsWith('ns-') && replied !== label)) {
      return `released namespace ${label}, but plumb reports ${replied === label ? '' : `${replied} as `}"${state}", not revoked`
    }
    entry.released = true
    return null
  }

  /** Release everything still held. `released` are the labels confirmed this call. */
  function releaseAll() {
    const released = []
    const problems = []
    for (const label of held.keys()) {
      if (held.get(label).released) continue
      const problem = release(label)
      if (problem === null) released.push(label)
      else problems.push(problem)
    }
    return { released, problems }
  }

  return {
    create,
    release,
    releaseAll,
    /** The ids this run created and has not yet seen revoked. */
    outstanding: () => [...held].filter(([, entry]) => !entry.released).map(([label]) => label),
    /** Every id this run created. */
    created: () => [...held.keys()],
  }
}

/**
 * Release the ledger's namespaces when the process exits, by whatever path that
 * is not a SIGKILL: normal exit, `process.exit` from a signal handler, an
 * uncaught exception. The handler is synchronous because 'exit' allows nothing
 * else, and it says nothing when there is nothing left to release.
 */
export function installExitRelease(ledger, { proc = process, write = (line) => process.stderr.write(line) } = {}) {
  const handler = () => {
    if (ledger.outstanding().length === 0) return
    const { released, problems } = ledger.releaseAll()
    for (const id of released) write(`e2e: exit: released namespace ${id}\n`)
    for (const problem of problems) write(`e2e: exit: ${problem}\n`)
  }
  proc.on('exit', handler)
  return handler
}

// -- the scenario's serves -------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The command every plumb process of a scenario goes through: dsh's `mcp-plumb`
 * row, the serve the plugin opens for each agent, its resume-proof hook, and the
 * harness's own note sender. It gives each of them the scenario's namespace
 * token and nothing else: no HOME, no XDG_*, so they all reach the one real
 * daemon. (The isolated-daemon wrapper does the opposite.)
 */
export function namespaceWrapperScript({ plumbBin, token }) {
  return `\
#!/bin/sh
# Generated by test/e2e-mock-provider.mjs — a plumb process in a scenario's namespace.
PLUMB_NAMESPACE=${shellQuote(token)}
export PLUMB_NAMESPACE
exec ${shellQuote(plumbBin)} "$@"
`
}

/** Write the wrapper next to the scenario's other files; it holds a secret, so it is owner-only. */
export function writeNamespaceWrapper({ root, plumbBin, token }) {
  const wrapper = path.join(root, 'plumb-namespaced.sh')
  fs.writeFileSync(wrapper, namespaceWrapperScript({ plumbBin, token }), { mode: 0o700 })
  fs.chmodSync(wrapper, 0o700)
  return wrapper
}

// -- where the shared daemon keeps what a scenario reads --------------------------------

/**
 * The directories of a plumb service profile, from `plumb service show`'s TOML:
 * the `[dirs]` table's entries (`data` and `log` are the ones used). Asked of plumb rather
 * than derived from HOME and XDG_*, because the daemon's directories come from
 * the service profile, not from any client's environment.
 */
export function parseServiceDirs(text) {
  const dirs = {}
  let inDirs = false
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    const table = /^\[([^\]]+)\]$/.exec(line)
    if (table) {
      inDirs = table[1].trim() === 'dirs'
      continue
    }
    if (!inDirs) continue
    // plumb writes TOML literal strings ('...', no escapes); a basic string ("...")
    // is read too, so a profile edited by hand still parses.
    const literal = /^([a-z]+)\s*=\s*'([^']*)'\s*$/.exec(line)
    const basic = literal ? null : /^([a-z]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (literal) dirs[literal[1]] = literal[2]
    else if (basic) dirs[basic[1]] = basic[2].replace(/\\(["\\])/g, '$1')
  }
  return dirs
}

/** `{ sessionsDir, daemonLog }` of the daemon namespace mode runs in, or throws saying why not. */
export function resolveDaemonFiles(plumbBin, { run = runPlumb } = {}) {
  const result = run(plumbBin, ['service', 'show'])
  if (result.error || result.status !== 0) {
    throw new Error(`cannot find the daemon's session directory and log: \`plumb service show\` failed: ${describeRun(result)}`)
  }
  const dirs = parseServiceDirs(result.stdout)
  for (const key of ['data', 'log']) {
    if (!path.isAbsolute(dirs[key] ?? '')) {
      throw new Error(`cannot find the daemon's session directory and log: \`plumb service show\` lists no absolute ${key} directory`)
    }
  }
  return { sessionsDir: path.join(dirs.data, 'sessions'), daemonLog: path.join(dirs.log, 'daemon.log') }
}

/**
 * What a scenario in namespace mode reads. The records are the shared daemon's
 * session directory filtered to the scenario's namespace; the daemon log is the
 * shared log filtered to the scenario's own sessions. `plumb sessions` is not
 * the source: it lists live sessions only, and the assertions need the ENDED
 * records of connections that idle-closed.
 */
export function namespaceSource({ namespaceId, sessionsDir, daemonLog, startedAtMs }) {
  const all = () => readRecordsIn(sessionsDir)
  const records = () => inNamespace(all(), namespaceId)
  return {
    kind: 'namespace',
    namespaceId,
    records,
    /** This scenario's lines of the shared daemon's log, or '' before it has written one. */
    daemonLog: () => {
      let text
      try {
        text = fs.readFileSync(daemonLog, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') return ''
        throw new Error(`cannot read the daemon log ${daemonLog}: ${error.code ?? error.message}`)
      }
      return logLinesForSessions(text, records().map((record) => record.id))
    },
    /** The e2e's own sessions that landed outside this scenario's namespace since it began. */
    strays: () => strayRecords(all(), namespaceId, startedAtMs),
  }
}

// -- choosing the isolation -----------------------------------------------------------------

/** The run was refused before it began: the plumb in use cannot do what namespace isolation needs. */
export class NamespaceUnavailable extends Error {}

/**
 * Choose the isolation for this run and, for namespace mode, check the plumb in
 * use can do it BEFORE any scenario starts. A plumb without namespaces throws
 * NamespaceUnavailable; it is never answered with `daemon`, because a daemon per
 * scenario is a different isolation, chosen only by naming it (E2E_ISOLATION=daemon).
 * Daemon isolation does not probe: it uses no namespaces.
 *
 * The collaborators are parameters so a test can drive every branch without a
 * daemon, and prove which of them a branch does not touch.
 */
export function resolveIsolation(plumbBin, {
  env = process.env,
  probe = probeNamespaceSupport,
  findFiles = resolveDaemonFiles,
  makeLedger = createNamespaceLedger,
  installExit = installExitRelease,
} = {}) {
  const { mode } = selectIsolation(env)
  if (mode === 'daemon') {
    return { mode, describe: 'daemon (a plumb daemon per scenario, under a private HOME)', ledger: null, files: null }
  }
  const support = probe(plumbBin)
  if (!support.ok) throw new NamespaceUnavailable(describeProbeFailure(support))
  const files = findFiles(plumbBin)
  const ledger = makeLedger({ plumbBin })
  installExit(ledger)
  return {
    mode,
    describe: `namespace (one daemon, a namespace per scenario; ${support.namespaces.length} already listed)`,
    ledger,
    files,
  }
}

// -- one scenario in a namespace ---------------------------------------------------------------

/**
 * A scenario's plumb in namespace isolation: its namespace, the wrapper that
 * puts every plumb process of the scenario in it, where its assertions read, the
 * two checks that make an absence assertion mean something, and its teardown.
 *
 * The token is recorded by the ledger BEFORE anything else can fail, and a
 * failure after that releases the namespace again, so a scenario that cannot be
 * set up leaves nothing active.
 *
 * `beforeExpect` and `afterExpect` return a problem or null. `teardown` resolves
 * `{ notes, problems }` and may be called twice (the signal handler's and the
 * scenario's own `finally`).
 */
export function createNamespaceEnvironment({ ledger, files, root, plumbBin, now = Date.now }) {
  const { id, token } = ledger.create()
  try {
    const source = namespaceSource({ namespaceId: id, sessionsDir: files.sessionsDir, daemonLog: files.daemonLog, startedAtMs: now() })
    return {
      plumbSh: writeNamespaceWrapper({ root, plumbBin, token }),
      source,
      namespaceId: id,
      // The positive control for the whole scenario: records exist in the
      // namespace. A reader looking in the wrong place, or serves that never
      // joined, sees none, and every absence check (`text-only` among them)
      // would pass on nothing.
      beforeExpect: () => (source.records().length > 0
        ? null
        : `namespace ${id} has no session record in ${files.sessionsDir}: the scenario's serves did not join it, or this reader is looking in the wrong place`),
      // The leak control: nothing the scenario started may sit outside its
      // namespace, where no assertion on its own records would ever look.
      afterExpect: () => {
        const stray = source.strays()
        return stray.length === 0
          ? null
          : `${stray.length} session(s) of the scenario's processes are outside namespace ${id}: ${stray.map((r) => `${r.id} (${r.clientName}, namespace ${r.namespace || 'default'})`).join(', ')}`
      },
      teardown: async () => {
        const problem = ledger.release(id)
        return problem === null ? { notes: [`released namespace ${id}`], problems: [] } : { notes: [], problems: [problem] }
      },
    }
  } catch (error) {
    const problem = ledger.release(id)
    throw new Error(problem === null ? error.message : `${error.message} (and ${problem})`)
  }
}
