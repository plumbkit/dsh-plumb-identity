// Host refusal for the e2e (PLAN-526). A developer machine runs exactly one plumb
// daemon: the one its own sessions use. The e2e's default isolation (PLAN-520)
// runs inside ONE daemon and gives each scenario a namespace of it; its older
// isolation (E2E_ISOLATION=daemon) starts a daemon per scenario. Neither is the
// owner's to start or to write rows into, so the suite runs only where it has a
// daemon that is not the owner's, and says so before it creates anything.
//
// Namespace isolation does NOT relax this by itself, and a namespace token in the
// environment (PLUMB_NAMESPACE) is not evidence. The one thing that does is the
// fourth kind of evidence below, which is narrower than the other three (namespace
// isolation only, a plumb that passed the capability probe, an explicit opt-in
// naming the daemon) and is the OWNER's choice, made each time.
//
// This is a guard against running the suite here BY ACCIDENT (an agent, a
// habit, a stale recipe), not a security boundary: anyone can fake the
// evidence below. It accepts exactly four kinds of evidence:
//   - GITHUB_ACTIONS=true, on any OS: a hosted CI runner;
//   - Linux with a readable regular-file container marker, /.dockerenv
//     (Docker) or /run/.containerenv (Podman);
//   - Linux with PLUMB_SEPARATE_ENV=vm: an explicit declaration that this is a
//     disposable VM;
//   - on a developer host, DSH_E2E_HOST_DAEMON=<pid>, accepted only when ALL of:
//       * the isolation is `namespace`, never `daemon`, which starts daemons;
//       * the capability probe passed: the plumb in use has namespaces and a
//         daemon answered them;
//       * `plumb debug daemons` lists EXACTLY ONE daemon and it holds the launch
//         authority (no daemon, two daemons, or a listing that cannot be read
//         refuse);
//       * that daemon's PID is the opt-in's, digit for digit.
// Nothing else counts: no CI=true, no override flag, no case folding, no
// trimming (a PID with a leading zero or a space is not a PID), and a marker
// that cannot be read counts as absent. The same vectors are tested for the
// Bash and Python copies of the first three rules in the plumb-ops harnesses.
//
// Why the fourth kind asks for each of those. The PID changes every time the
// daemon restarts, so a stale recipe, a shell history entry or a copied command
// cannot re-run the suite later: the owner has to look at the daemon as it is
// now (`plumb debug daemons`) and name it. Exactly one daemon holding the
// authority is the state in which "the owner's daemon" means one process; with
// two (the leak the census exists to find) or none the PID would name nothing the
// run is about. Namespace isolation writes only rows inside namespaces the run
// created itself, released at each scenario's teardown and leased to the runner's
// pid so they expire once it is gone; it starts, stops and signals no daemon. The
// daemon isolation does all of that, so it is never allowed here. The probe is the
// run's own precondition, taken before any namespace exists.
//
// Those rules are NOT in separateEnvironment(): that function, and
// fixtures/separate-env-vectors.json, are byte-identical with plumb's, and the
// fourth kind is not a separate environment at all. It is hostNamespaceOptIn(),
// with its own vectors (fixtures/host-namespace-vectors.json). Both are decided
// together by hostDecision(), which the e2e calls, and which asks for the probe
// and the listing only once the cheaper conditions hold.

import fs from 'node:fs'

export const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv']

/**
 * The kind of separate environment this process runs in, or null when it may be
 * a developer host.
 * @param {{env?: Record<string,string|undefined>, platform?: string, readable?: (p: string) => boolean}} [deps]
 * @returns {'github-actions'|'container'|'vm'|null}
 */
export function separateEnvironment({ env = process.env, platform = process.platform, readable = readableFile } = {}) {
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions'
  if (platform !== 'linux') return null
  if (CONTAINER_MARKERS.some((marker) => readable(marker))) return 'container'
  if (env.PLUMB_SEPARATE_ENV === 'vm') return 'vm'
  return null
}

/** True only for a regular file this process can open for reading. */
export function readableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.closeSync(fs.openSync(file, 'r'))
    return true
  } catch {
    return false
  }
}

// -- the fourth kind of evidence: the owner's opt-in to a namespace run ---------------

/** The opt-in: the PID of the one plumb daemon this run may use, as `plumb debug daemons` lists it. */
export const HOST_OPT_IN_ENV = 'DSH_E2E_HOST_DAEMON'

const PLAIN_PID = /^[1-9][0-9]*$/

/**
 * Why the opt-in is not accepted, or null when it is. `isolation`, `probePassed`
 * and `daemons` are values or functions returning them; a function is called
 * only when every earlier condition held, so nothing is probed or listed for an
 * opt-in that is already refused. A function that throws refuses, with its message.
 * @returns {null | {condition: 'opt-in'|'isolation'|'probe'|'daemons'|'authority'|'pid', why: string}}
 */
export function explainHostNamespace({ env, isolation, probePassed, daemons } = {}) {
  const optIn = env?.[HOST_OPT_IN_ENV]
  if (typeof optIn !== 'string' || !PLAIN_PID.test(optIn)) {
    return refuse('opt-in', optIn === undefined
      ? `${HOST_OPT_IN_ENV} is not set`
      : `${HOST_OPT_IN_ENV}=${JSON.stringify(optIn)} is not a plain decimal PID (digits only, no leading zero, no spaces)`)
  }
  const mode = ask(isolation)
  if (mode.error !== undefined) return refuse('isolation', `the isolation could not be selected: ${mode.error}`)
  if (mode.value !== 'namespace') {
    return refuse('isolation', `${HOST_OPT_IN_ENV} covers namespace isolation only; this run would use ${JSON.stringify(mode.value ?? null)}`)
  }
  const probe = ask(probePassed)
  if (probe.error !== undefined) return refuse('probe', `the capability probe could not run: ${probe.error}`)
  if (probe.value !== true) {
    return refuse('probe', 'the capability probe did not pass: the plumb in use needs namespaces (`plumb namespace`) and a running daemon that answers them')
  }
  const listing = ask(daemons)
  if (listing.error !== undefined) return refuse('daemons', `\`plumb debug daemons\` could not be run: ${listing.error}`)
  const rows = listing.value
  if (!Array.isArray(rows)) {
    return refuse('daemons', '`plumb debug daemons` could not be read, or did not exit 0 (it does so only when the account has exactly one daemon and it holds the authority)')
  }
  if (rows.length !== 1) {
    return refuse('daemons', `\`plumb debug daemons\` lists ${rows.length} daemons; ${HOST_OPT_IN_ENV} needs exactly one`)
  }
  const [daemon] = rows
  if (typeof daemon !== 'object' || daemon === null) return refuse('daemons', '`plumb debug daemons` listed a row that is not a daemon')
  if (daemon.authority !== true) {
    return refuse('authority', `the one daemon (${JSON.stringify(daemon.pid ?? null)}) does not hold the launch authority`)
  }
  if (!Number.isSafeInteger(daemon.pid) || String(daemon.pid) !== optIn) {
    return refuse('pid', `${HOST_OPT_IN_ENV}=${optIn} is not the running daemon's PID (${JSON.stringify(daemon.pid ?? null)}): the PID changes whenever the daemon restarts, so the owner names it afresh each run`)
  }
  return null
}

function refuse(condition, why) {
  return { condition, why }
}

/** A value, or the result of calling it when it is a function; a throw is captured as its message. */
function ask(source) {
  if (typeof source !== 'function') return { value: source }
  try {
    return { value: source() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The fourth kind of evidence (see the header): `'host-namespace'` when the
 * owner's opt-in is accepted for this run, otherwise null.
 * @param {{env: Record<string,string|undefined>, isolation: unknown, probePassed: unknown, daemons: unknown}} input
 *   `daemons` is parseDebugDaemons()'s result: `[{pid, authority}]`, or null.
 * @returns {'host-namespace'|null}
 */
export function hostNamespaceOptIn(input) {
  return explainHostNamespace(input) === null ? 'host-namespace' : null
}

/**
 * The e2e's whole decision about where it may run. `separate` is
 * separateEnvironment()'s answer; when it names an environment that is the
 * decision and nothing is asked. On a host it falls to the opt-in, and the three
 * functions are asked in order, each only if the ones before it held.
 * @returns {{allow: true, kind: 'github-actions'|'container'|'vm'} | {allow: true, kind: 'host-namespace', pid: number} | {allow: false, condition: string, why: string}}
 */
export function hostDecision({ env = process.env, separate = null, isolation, probePassed, daemons } = {}) {
  if (separate === 'github-actions' || separate === 'container' || separate === 'vm') return { allow: true, kind: separate }
  if (env[HOST_OPT_IN_ENV] === undefined) {
    return {
      allow: false,
      condition: 'opt-in',
      why: `this is not a CI runner, a container or a declared VM, and ${HOST_OPT_IN_ENV} is not set`,
    }
  }
  const refused = explainHostNamespace({ env, isolation, probePassed, daemons })
  if (refused !== null) return { allow: false, ...refused }
  return { allow: true, kind: 'host-namespace', pid: Number(env[HOST_OPT_IN_ENV]) }
}

// -- reading `plumb debug daemons` ----------------------------------------------------------

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const COLUMNS = ['PID', 'PPID', 'STARTED', 'EXECUTABLE', 'AUTHORITY', 'SOCKET', 'FOUND BY']
const HEADER = /^ {2}PID {2,}PPID {2,}STARTED {2,}EXECUTABLE {2,}AUTHORITY {2,}SOCKET {2,}FOUND BY *$/
const ROW_START = /^ {2}[0-9]/
const NO_DAEMON = '  no plumb daemon process was found for this account'
const UNKNOWN_NOTE = /^ {2}!\s+unknown:/
const POSITIVE = /^[1-9][0-9]*$/

/**
 * `plumb debug daemons` read as `[{pid, authority}]`, in the order listed; `[]`
 * when it says no daemon was found; null when it cannot be read with certainty.
 * Null is what refuses, so anything this does not recognise is null: a changed
 * layout, a cell that is not what the renderer writes, a census that says it
 * could not read everything.
 *
 * The listing is a text/tabwriter table (internal/cli/debug_daemons.go in plumb):
 * every cell padded with two spaces to its column's width, so the header's
 * offsets are every row's, whatever the EXECUTABLE path holds (spaces, non-ASCII
 * characters). Offsets are counted in code points, as tabwriter counts runes.
 * Colour escapes and the logo are not part of it.
 * @returns {{pid: number, authority: boolean}[] | null}
 */
export function parseDebugDaemons(text) {
  if (typeof text !== 'string') return null
  const lines = text.replace(ANSI, '').split(/\r?\n/)
  if (lines.some((line) => UNKNOWN_NOTE.test(line))) return null
  const headers = lines.flatMap((line, index) => (HEADER.test(line) ? [index] : []))
  const rowLines = lines.flatMap((line, index) => (ROW_START.test(line) ? [index] : []))
  if (headers.length === 0) {
    const none = lines.filter((line) => line === NO_DAEMON).length
    return none === 1 && rowLines.length === 0 ? [] : null
  }
  if (headers.length !== 1 || lines.includes(NO_DAEMON)) return null
  const [head] = headers
  // The table is the unbroken run of rows under the header, and nothing else in
  // the output may look like a row.
  const table = rowLines.filter((index, n) => index === head + 1 + n)
  if (table.length === 0 || table.length !== rowLines.length) return null
  const offsets = []
  let from = 0
  for (const name of COLUMNS) {
    from = lines[head].indexOf(name, from)
    offsets.push(from)
    from += name.length
  }
  const daemons = []
  for (const index of table) {
    const daemon = parseRow(lines[index], offsets)
    if (daemon === null) return null
    daemons.push(daemon)
  }
  if (new Set(daemons.map((d) => d.pid)).size !== daemons.length) return null
  return daemons
}

function parseRow(line, offsets) {
  const chars = Array.from(line)
  // Every column after the first is preceded by the table's two-space padding; a
  // row that does not line up with the header is not read.
  for (const offset of offsets.slice(1)) {
    if (chars[offset - 1] !== ' ' || chars[offset - 2] !== ' ') return null
  }
  const cell = (n) => chars.slice(offsets[n], offsets[n + 1] ?? chars.length).join('').trimEnd()
  const [pid, ppid, started, executable, authority, socket] = [0, 1, 2, 3, 4, 5].map(cell)
  if (!POSITIVE.test(pid) || !Number.isSafeInteger(Number(pid))) return null
  if (!POSITIVE.test(ppid) && ppid !== '-') return null
  if (started === '' || executable === '') return null
  if (authority !== 'yes' && authority !== '-') return null
  if (socket !== 'yes' && socket !== '-') return null
  return { pid: Number(pid), authority: authority === 'yes' }
}

/**
 * The listing from the result of running `plumb debug daemons`
 * (`{status, signal, error, stdout}`, as namespace-mode's runPlumb returns). It
 * exits 0 only when the account has exactly one daemon and it holds the
 * authority and no socket is where it should not be, so any other exit is not a
 * listing to act on, whatever the text says.
 */
export function daemonsFromRun(result) {
  if (!result || result.error || result.signal || result.status !== 0) return null
  return parseDebugDaemons(result.stdout)
}

/**
 * The refusal printed when the e2e may not run here: no separate environment and
 * no accepted opt-in. It is read by whoever is refused, an agent included, so it
 * forbids the opt-in rather than explaining how to give it: the recipe is the README's.
 */
export function refusal(what) {
  return [
    `${what}: refusing to run here: it drives a plumb daemon (with E2E_ISOLATION=daemon, starts`,
    'daemons of its own), and a developer machine must run exactly one plumb daemon, the one',
    'its sessions use, which a test is not to start, stop or write namespaces into.',
    'Run it in a separate environment instead:',
    '  test/e2e-container.sh --plumb <linux plumb binary>   (Docker; see README)',
    'Accepted evidence: GITHUB_ACTIONS=true; Linux with a readable /.dockerenv or',
    '/run/.containerenv; Linux with PLUMB_SEPARATE_ENV=vm (a disposable VM).',
    "A narrower opt-in exists for the machine's OWNER ONLY.",
    'An agent must not set DSH_E2E_HOST_DAEMON; ask the owner. See README.',
  ].join('\n')
}
