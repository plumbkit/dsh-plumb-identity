#!/usr/bin/env node
// End-to-end verification of the identity plugin against a FAKE MODEL.
//
// Real DSH agent loop, this plugin mounted from the working tree, real plumb —
// only the model is scripted (see ./fake-model.mjs). The run therefore costs
// zero LLM credits and needs no network beyond localhost.
//
// Everything disposable lives in one temp root per scenario:
//   - a throwaway DSH_HOME whose only configured LLM provider is the local
//     fake, so a misrouted run fails on "unknown provider" instead of billing
//     a real key — OpenRouter is unreachable by construction;
//   - the harness's hoisted node_modules, symlinked in so DSH and the MCP SDK
//     resolve (the plugin's default sdkPath rides the same symlink);
//   - the plugin mounted via a `file://` patch row, so the working tree — the
//     code under test — is exactly what runs;
//   - the scenario's plumb, isolated one of two ways (E2E_ISOLATION, see
//     namespace-mode.mjs):
//       namespace (default)  ONE plumb daemon, already running, for the whole
//                            run; the scenario creates a plumb namespace and
//                            every `plumb serve` it causes joins it through
//                            PLUMB_NAMESPACE. It starts and stops no daemon.
//       daemon               a plumb daemon of the scenario's own: HOME and XDG
//                            roots are redirected under the temp root, and
//                            session-manager (TSM_ORIG_*) companions are
//                            stripped so plumb's hijack recovery cannot
//                            relocate the sandbox back at the real user state.
//     Assertions read plumb's own session records, never the mock.
//
// Usage:
//   npm run test:e2e                       every scenario
//   node test/e2e-mock-provider.mjs --mode tool-call [--mode subagent]
//   --keep / E2E_KEEP=1                    keep temp roots for debugging
//   --list                                 print the scenario names and exit
//
// Where: not on a developer machine, unless its owner says so. The suite refuses
// to start (exit 2) unless separate-env.mjs finds a CI runner, a container or a
// declared VM, whichever isolation is chosen: a namespace run still talks to a
// daemon, and a developer machine's one daemon is not a test's to talk to.
// test/e2e-container.sh runs it in Docker, starts the one daemon namespace mode
// needs, and checks that exactly one daemon ran and none outlives it.
//
// The owner's exception is DSH_E2E_HOST_DAEMON=<pid of the one daemon `plumb debug
// daemons` lists>, accepted only for namespace isolation and a plumb that passed
// the capability probe (separate-env.mjs has the whole rule). It is decided in
// main() before a scenario root, a namespace or a signal handler exists, and a
// run it refuses prints why and exits 2.
//
// E2E_ISOLATION=namespace|daemon   default namespace. Namespace mode probes the
//                                  plumb in use first and REFUSES (exit 2) when it
//                                  has no namespaces; it never falls back to a
//                                  daemon per scenario. `daemon` is the old
//                                  isolation, chosen only by naming it.
// --isolation                      print the isolation this run would use and exit
//
// Requirements: a dsh install (DSH_BIN, else the $DSH_HOME / ~/.dsh profile
// tree, exactly what dsh itself resolves) and a plumb binary (PLUMB_BIN, else
// ../plumb/plumb beside this checkout, else `plumb` on PATH).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeModel, TYPED_SESSION_ID } from './fake-model.mjs'
import { endProcessGroup, stopIsolatedDaemon, walkDirs } from './isolated-daemon.mjs'
import { createNamespaceEnvironment, NamespaceUnavailable, probeNamespaceSupport, resolveIsolation, runPlumb, selectIsolation } from './namespace-mode.mjs'
import { daemonsFromRun, HOST_OPT_IN_ENV, hostDecision, refusal, separateEnvironment } from './separate-env.mjs'
import { readRecordsUnder } from './session-records.mjs'
import { installSignalTeardown } from './signal-teardown.mjs'

// Either isolation drives a plumb daemon (a developer host's one daemon is not a
// test's), so refuse on a developer host before resolving anything, creating a
// root, creating a namespace or installing a signal handler. The one exception is
// the owner's opt-in, which needs the isolation and the plumb in use to be judged:
// main() decides it first thing (requireHostDecision), before any of those exist.
const SEPARATE = separateEnvironment()
if (SEPARATE === null && process.env[HOST_OPT_IN_ENV] === undefined) {
  console.error(refusal('e2e'))
  process.exit(2)
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_FILE = path.join(REPO_ROOT, 'dsh-plumb-identity.mjs')
const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS ?? 180_000)
const DECLARE_TIMEOUT_MS = 20_000

const SCENARIOS = {
  'tool-call': {
    task: 'Use the mcp__plumb__daemon_info tool once, then reply with exactly: done',
    expect: async (ctx) => {
      const record = await pollForDeclared(ctx, (r) => r.purpose === 'dsh' && r.isIdentity)
      return record ? null : 'no plumb session record declared purpose "dsh" with external_id "dsh-*"'
    },
  },
  'text-only': {
    task: 'Reply with exactly: done',
    expect: async (ctx) => {
      await sleep(2_000)
      const declared = readSessionRecords(ctx).filter((r) => r.purpose === 'dsh' || r.purpose === 'dsh-subagent')
      return declared.length === 0 ? null : `expected no declarations without a plumb tool call, found ${declared.map((r) => `${r.purpose}:${r.externalId}`).join(', ')}`
    },
  },
  // The proof of the per-agent design: TWO agents call plumb, so the shared
  // design yields ONE connection carrying stamped identities, while this design
  // yields one connection EACH, declaring on itself. The control is the same
  // scenario run with `perAgentConnection: false`, which leaves the shared row
  // carrying the identity and no `dsh-plumb-identity` record at all.
  'per-agent': {
    task: 'Use the mcp__plumb__daemon_info tool once. Then delegate one subagent with the subagent tool; the subagent must also use the mcp__plumb__daemon_info tool once. Then reply with exactly: done.',
    expect: async (ctx) => {
      const deadline = Date.now() + DECLARE_TIMEOUT_MS
      let perAgent = []
      while (Date.now() < deadline) {
        perAgent = readSessionRecords(ctx).filter((r) => r.clientName === 'dsh-plumb-identity')
        const seen = new Set(perAgent.map((r) => r.purpose))
        if (seen.has('dsh') && seen.has('dsh-subagent')) break
        await sleep(500)
      }
      if (perAgent.length < 2) {
        return `expected one connection per calling agent (2), found ${perAgent.length}: ${perAgent.map((r) => `${r.clientName}/${r.purpose}`).join(', ') || 'none'}`
      }
      const ids = new Set(perAgent.map((r) => r.externalId))
      if (ids.size !== perAgent.length) return `two agents shared one external id: ${[...ids].join(', ')}`
      const purposes = new Set(perAgent.map((r) => r.purpose))
      if (!purposes.has('dsh') || !purposes.has('dsh-subagent')) {
        return `expected the conversation and the subagent to declare, got purposes ${[...purposes].join(', ')}`
      }
      // The shared row is still there (it serves discovery) but must carry NO
      // declaration: that is the difference between routing the call and merely
      // stamping the shared connection.
      const shared = readSessionRecords(ctx).filter((r) => r.clientName === 'dsh-mcp-client')
      if (shared.some((r) => r.isIdentity)) {
        return 'the shared connection carries a declaration — the call did not move off it'
      }
      return null
    },
  },
  subagent: {
    task: 'Delegate one subagent with the subagent tool; it must use the mcp__plumb__daemon_info tool once. Then reply with exactly: done.',
    expect: async (ctx) => {
      const record = await pollForDeclared(ctx, (r) => r.purpose === 'dsh-subagent' && r.isIdentity)
      if (!record) return 'no plumb session record declared purpose "dsh-subagent" with external_id "dsh-*"'
      // The declaration must sit on the SUBAGENT's own connection, not on the
      // shared one: that is the whole difference between routing a call and
      // stamping an identity onto a connection everybody shares.
      if (record.clientName !== 'dsh-plumb-identity') {
        return `the subagent declared over "${record.clientName}", not its own connection`
      }
      if (readSessionRecords(ctx).some((r) => r.clientName === 'dsh-mcp-client' && r.isIdentity)) {
        return 'the shared connection also carries a declaration — a call did not move off it'
      }
      return null
    },
  },
  // PLAN-500. A note is waiting for whoever attaches next BEFORE the agent's
  // first plumb call. That call makes the plugin declare the agent with an
  // AUTOMATIC session_start, whose packet the model never sees. If that
  // session_start claims mail (plumb's default), the note is consumed there
  // and check_messages returns nothing. With `mail: 'preview'` it is still
  // waiting, and the model receives it from check_messages, exactly once.
  // Control: delete the plugin's `mail: 'preview'` and this scenario fails.
  // (A note sent WHILE the agent is connected is a different defect, PLAN-463,
  // and is deliberately not tested here.)
  mail: {
    task: 'Use the mcp__plumb__daemon_info tool once, then the mcp__plumb__check_messages tool once, then reply with exactly: done',
    setup: fileWaitingNote,
    expect: async ({ fake, setup }) => {
      const results = fake.toolResults
      if (!results.some((r) => /check_messages$/.test(r.name ?? ''))) {
        return `the model never received a check_messages result (tool results: ${results.map((r) => r.name).join(', ') || 'none'})`
      }
      const hits = results.flatMap((r) => Array(r.content.split(setup.marker).length - 1).fill(r.name))
      if (hits.length === 0) {
        return 'the waiting note never reached the model: it was claimed where the model cannot see it (the automatic session_start)'
      }
      if (hits.length > 1) return `the waiting note reached the model ${hits.length} times (${hits.join(', ')}), expected exactly once`
      if (!/check_messages$/.test(hits[0] ?? '')) return `the waiting note reached the model through ${hits[0]}, not check_messages`
      return null
    },
  },
  // PLAN-510. A note sent to the agent WHILE it is connected is bound to its
  // current plumb session. The agent's own connection then idle-closes, and its
  // next plumb call opens a new one. Before the resume proof, plumb gave the new
  // connection a NEW session id under the same name, and the note stayed bound
  // to the old id: stranded, never delivered. With the proof, the new
  // connection resumes the same session and check_messages delivers the note,
  // exactly once. The model is held between its two calls (fake-model's
  // `reconnect` mode) while the harness sends the note and waits for plumb to
  // record the connection's end, so the reconnect is observed, not assumed.
  // Control: E2E_RESUME_PROOF=0 mounts the plugin with `resumeProof: false`,
  // and this scenario must FAIL.
  reconnect: {
    task: 'Use the mcp__plumb__daemon_info tool once, then the mcp__plumb__check_messages tool once, then reply with exactly: done',
    // Long enough that the note is sent well inside the connected window (the
    // gate opens as the first call returns), short enough to keep the run quick.
    idleMs: 8_000,
    gate: noteWhileConnectedThenReconnect,
    expect: expectNoteSurvivedReconnect,
  },
  // PLAN-510's live failure, reproduced: the agent follows its brief and
  // declares a session_id of its own (fake-model's `declared-id` mode) on a
  // connection whose proven identity is the plugin's. Before normalisation that
  // REPLACED the linkage — the resume credential was revoked 48 ms after it was
  // issued, the connection was marked shared (every state-changing call on it
  // refused), and every reconnect after it resumed by name only, so the note
  // bound to the old id stranded. With normalisation the typed id is taken over
  // and the run behaves exactly like `reconnect`.
  // Control: E2E_NORMALISE=0 mounts the plugin with `normaliseDeclarations:
  // false`, and this scenario must FAIL.
  'declared-id': {
    task: 'Use the mcp__plumb__session_start tool once with a session_id of your own choosing, then the mcp__plumb__daemon_info tool once, then the mcp__plumb__check_messages tool once, then reply with exactly: done',
    idleMs: 8_000,
    gate: noteWhileConnectedThenReconnect,
    expect: async (ctx) => {
      const typed = declaredIdWasTakenOver(ctx)
      if (typed !== null) return typed
      return expectNoteSurvivedReconnect(ctx)
    },
  },
  // The same takeover on the SHARED connection. `prepareCall` normalises for
  // both dispatch paths, and the unit test only proves the arguments object is
  // rewritten — not that real DSH sends the rewritten object down this path. So
  // this pins the wire: exactly one linkage reaches the daemon even though the
  // model declared its own. The reconnect assertions do not apply here (a
  // shared serve has no own connection to resume), so this is the shared half
  // of `declared-id`, pinned rather than checked by hand.
  // Control: E2E_NORMALISE=0 mounts the plugin with `normaliseDeclarations:
  // false`, and this scenario must FAIL.
  'declared-id-fallback': {
    fakeMode: 'declared-id',
    perAgentConnection: false,
    task: 'Use the mcp__plumb__session_start tool once with a session_id of your own choosing, then the mcp__plumb__daemon_info tool once, then reply with exactly: done',
    expect: declaredIdWasTakenOver,
  },
}

/**
 * The assertions PLAN-510's two scenarios share: the agent reconnected over a
 * SECOND own connection, the note sent while it was connected arrived exactly
 * once through check_messages, and its plumb session id is the same on both
 * sides of the reconnect.
 */
async function expectNoteSurvivedReconnect({ source, fake, gate }) {
  if (gate.error) return `the reconnect was never staged: ${gate.error}`
  if (!gate.ended) return 'the gate never ran, so no reconnect was staged'
  // The positive control: check_messages went over a SECOND connection. Each
  // connection leaves a record, resumed or not, so one connection is a run in
  // which nothing reconnected and the rest of this proves nothing.
  const connections = readSessionRecords({ source }).filter((r) => r.clientName === 'dsh-plumb-identity')
  if (connections.length < 2) return `expected the agent to reconnect (two own connections), found ${connections.length}`
  const results = fake.toolResults
  if (!results.some((r) => /check_messages$/.test(r.name ?? ''))) {
    return `the model never received a check_messages result (tool results: ${results.map((r) => r.name).join(', ') || 'none'})`
  }
  const hits = results.flatMap((r) => Array(r.content.split(gate.marker).length - 1).fill(r.name))
  const ids = [...new Set(agentRecords({ source }).map((r) => r.id))]
  if (hits.length === 0) {
    return `the note sent while the agent was connected never reached it after the reconnect: stranded on session ${gate.sessionId} (agent session ids seen: ${ids.join(', ')})`
  }
  if (hits.length > 1) return `the note reached the model ${hits.length} times (${hits.join(', ')}), expected exactly once`
  if (!/check_messages$/.test(hits[0] ?? '')) return `the note reached the model through ${hits[0]}, not check_messages`
  if (ids.length !== 1 || ids[0] !== gate.sessionId) {
    return `the agent's plumb session id changed across the reconnect: ${gate.sessionId} -> ${ids.join(', ')}`
  }
  return null
}

/**
 * `declared-id` only: the id the MODEL typed must never become a declared
 * linkage, and it must not mark the connection shared. Both are the live
 * symptoms beside the stranded note — on 2026-10-11 the credential was revoked
 * 48 ms after it was issued and every state-changing call on that connection
 * was refused.
 */
function declaredIdWasTakenOver({ source }) {
  const records = readSessionRecords({ source })
  // The positive control for every absence check below: the plugin's own
  // declaration reached plumb and this reader can see it. Without it a reader
  // pointed at the wrong place finds no typed id and no mark, and "nothing
  // wrong" is exactly what it would report.
  if (!records.some((r) => r.isIdentity)) {
    return 'no session record carries the plugin\'s declared identity, so the checks below have nothing to look at'
  }
  // Every check runs and every failure is reported, so a red control names each
  // symptom it produces rather than only the first the code happens to reach.
  const problems = []
  const typed = records.filter((r) => r.externalId === TYPED_SESSION_ID)
  if (typed.length > 0) {
    problems.push(`the model's own session_id (${TYPED_SESSION_ID}) became a declared linkage on ${typed.length} record(s) — two logical agents on one connection`)
  }
  const marked = records.filter((r) => r.health === 'shared_connection_detected')
  if (marked.length > 0) {
    problems.push(`the typed declaration marked ${marked.length} connection(s) shared_connection_detected, where anonymous state-changing calls are refused: ${marked.map((r) => r.id).join(', ')}`)
  }
  // What the DAEMON saw, which is the sharpest form of the same fact: a second
  // logical agent on one connection is exactly what makes it log the shared
  // connection warning. That is the symptom an isolated run can observe
  // deterministically — in production the same declaration also replaces the
  // identity row's linkage and revokes the resume credential (observed live
  // 2026-10-11), but whether the daemon ADOPTS a second linkage or merely
  // registers it depends on its roster/owner rules, which a scripted model does
  // not reach. Matched on the message, not the agent id: the line prints the id
  // through plumb's abbreviating label, so the full id is not in it.
  const daemonLog = source.daemonLog()
  // The positive control for that check: the scenario's connections left lines in
  // the log this reads (a daemon logs one when each connects). In a shared
  // daemon's log the scenario's lines are picked out by its session ids, so a log
  // read from the wrong place, or lines no longer tagged with them, would
  // otherwise report "no shared connection" about nothing.
  if (daemonLog.trim() === '') {
    problems.push('the daemon log holds no line for this scenario\'s sessions, so its shared-connection check has nothing to look at')
  } else if (daemonLog.includes('shared connection detected')) {
    problems.push('the daemon reported a shared connection: the model\'s typed declaration registered a second logical agent on it')
  }
  return problems.length === 0 ? null : problems.join('; ')
}

/** The isolated daemon's own log, or '' before it has written one. */
function readDaemonLogUnder(plumbHome) {
  for (const dir of walkDirs(plumbHome, 0)) {
    const file = path.join(dir, 'daemon.log')
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  }
  return ''
}

// The scenarios' environments not yet torn down (a daemon to stop, or a namespace
// to release), and the process groups of dsh runs not yet ended. A runner stopped
// by a signal (a tool timeout, ^C) never reaches runScenario's finally, so
// signal-teardown.mjs ends and tears down these before exiting. A SIGKILL cannot
// be handled: in daemon mode the container's exit ends the daemon, and in
// namespace mode `--owner-pid` makes the namespace expire once the runner is gone.
const liveEnvironments = new Map() // root -> environment
const liveGroups = new Set()
// Set by the handler: main starts no further scenario and leaves the exit to it.
let shuttingDown = false

// The plumb binary in use, resolved once. Declared here, not beside resolvePlumb:
// main() runs (and resolves it) before the rest of this module has been evaluated.
let resolvedPlumb = null

/** Installed by main() once the host decision is made, so a refused run has no handler. */
function installTeardownHandler() {
  installSignalTeardown({
    environments: liveEnvironments,
    endGroups: endDshGroups,
    onSignal: () => { shuttingDown = true },
  })
}

/** End every dsh process group still recorded, with whatever serves it holds. */
async function endDshGroups() {
  const problems = []
  for (const pgid of liveGroups) {
    const problem = await endProcessGroup(pgid)
    if (problem) problems.push(problem)
    liveGroups.delete(pgid)
  }
  return problems
}

main().catch((error) => {
  console.error(`e2e: ${error.message}`)
  // A run refused before it began (a plumb without namespaces) is exit 2, like the
  // host refusal; any other error is a failure.
  process.exit(error instanceof NamespaceUnavailable ? 2 : 1)
})

/**
 * Whether this run may be here, decided before anything is created: not at all
 * (exit 2, with the condition that refused), or on a separate environment, or on
 * the developer host by the owner's opt-in. The probe and the listing it asks
 * for are read-only plumb commands (`namespace --help`, `namespace list --json`,
 * `debug daemons`); nothing is started, signalled or created.
 */
function requireHostDecision() {
  let probe = null
  const decision = hostDecision({
    env: process.env,
    separate: SEPARATE,
    isolation: () => selectIsolation(process.env).mode,
    probePassed: () => {
      probe = probeNamespaceSupport(resolvePlumb())
      return probe.ok
    },
    daemons: () => daemonsFromRun(runPlumb(resolvePlumb(), ['debug', 'daemons'], { env: { NO_COLOR: '1' }, timeoutMs: 15_000 })),
  })
  if (!decision.allow) {
    console.error(`e2e: ${HOST_OPT_IN_ENV} was not accepted: ${decision.why}`)
    if (probe && !probe.ok) console.error(`e2e: the probe said: ${probe.detail}`)
    console.error(refusal('e2e'))
    process.exit(2)
  }
  if (decision.kind === 'host-namespace') {
    console.log(`e2e: running on the developer host in namespace isolation against plumb daemon ${decision.pid} (${HOST_OPT_IN_ENV})`)
  }
}

async function main() {
  requireHostDecision()
  installTeardownHandler()
  const args = process.argv.slice(2)
  // The scenario names, one per line: test/container/run.sh checks the run
  // passed every one of them, so a scenario that never ran cannot pass.
  if (args.includes('--list')) {
    console.log(Object.keys(SCENARIOS).join('\n'))
    process.exit(0)
  }
  // The isolation this run would use, for test/container/run.sh: it starts the
  // one daemon namespace mode needs, and must agree with this file on whether to.
  if (args.includes('--isolation')) {
    console.log(selectIsolation(process.env).mode)
    process.exit(0)
  }
  const keep = args.includes('--keep') || process.env.E2E_KEEP === '1'
  const wanted = args.includes('--mode') ? args.flatMap((a, i) => (a === '--mode' ? [args[i + 1]] : [])) : Object.keys(SCENARIOS)
  for (const mode of wanted) {
    if (!SCENARIOS[mode]) throw new Error(`unknown scenario "${mode}" (expected one of ${Object.keys(SCENARIOS).join(', ')})`)
  }

  const harness = resolveHarness()
  const plumbBin = resolvePlumb()
  const isolation = resolveIsolation(plumbBin)
  console.log(`e2e: harness ${harness.label}`)
  console.log(`e2e: plumb   ${plumbBin}`)
  console.log(`e2e: plugin  ${PLUGIN_FILE}`)
  console.log(`e2e: isolation ${isolation.describe}`)

  let failures = 0
  for (const mode of wanted) {
    if (shuttingDown) break
    const passed = await runScenario({ mode, task: SCENARIOS[mode].task, harness, plumbBin, isolation, keep })
    if (!passed) failures += 1
  }
  // A signal handler is tearing down and will exit with 128 + its signal.
  if (shuttingDown) return new Promise(() => {})
  // Every namespace this run created must be revoked by now: one left active
  // would sit in the shared daemon until its TTL ran out.
  const left = isolation.ledger?.outstanding() ?? []
  if (left.length > 0) {
    console.error(`  FAIL namespaces: ${left.length} namespace(s) were never released: ${left.join(', ')}`)
    failures += 1
  }
  console.log(failures === 0 ? `\ne2e: all ${wanted.length} scenario(s) passed` : `\ne2e: ${failures} scenario(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

// -- one scenario ----------------------------------------------------------------

async function runScenario({ mode, task, harness, plumbBin, isolation, keep }) {
  // Scenario roots must live shallow: the isolated plumb daemon's Unix socket
  // is $HOME-derived, and macOS's default per-user temp dir alone blows past
  // the 104-byte sun_path ceiling (plumb refuses with exactly that hint).
  const parent = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  const root = fs.mkdtempSync(path.join(parent, `dsh-identity-e2e-${mode}-`))
  let fake
  let environment = null
  let passed = false
  const scenario = SCENARIOS[mode]
  // What the scenario's gate did, for its expect (see fake-model's `reconnect`).
  const gate = {}
  let runGate = null
  console.log(`\n=== ${mode} ===`)
  try {
    // Before the fake model: `declared-id` declares a workspace with its typed
    // session_id, the way the brief tells a DSH agent to (see decideDeclaredId).
    const workspace = path.join(root, 'workspace')
    fake = await createFakeModel({
      mode: scenario.fakeMode ?? mode,
      log: (line) => console.log(`  ${line}`),
      beforeCheckMessages: scenario.gate ? () => runGate() : undefined,
      workspace,
    })
    environment = createEnvironment({ isolation, root, plumbBin })
    liveEnvironments.set(root, environment)
    const { plumbSh, source } = environment
    if (environment.namespaceId) console.log(`  namespace ${environment.namespaceId}`)
    const idleMs = scenario.idleMs ?? Number(process.env.E2E_IDLE_MS ?? 60000)
    // A scenario may pin the topology it needs (declared-id-fallback); otherwise
    // E2E_PER_AGENT=0 is the standing control that runs every scenario on the
    // shared connection.
    const perAgent = scenario.perAgentConnection ?? process.env.E2E_PER_AGENT !== '0'
    const home = buildDshHome({ root, fakeUrl: fake.url, plumbSh, hoisted: harness.hoisted, idleMs, perAgent })
    fs.mkdirSync(workspace, { recursive: true })
    const setup = scenario.setup ? await scenario.setup({ workspace, plumbSh }) : {}
    if (scenario.gate) {
      runGate = () => scenario.gate({ source, workspace, plumbSh, idleMs, gate }).catch((error) => {
        gate.error = error.message
        throw error
      })
    }

    const run = await runDsh(harness, ['--profile', 'e2e', task], {
      cwd: workspace,
      timeoutMs: RUN_TIMEOUT_MS,
      env: {
        ...process.env,
        DSH_HOME: home,
        // The plugin spawns its OWN `plumb serve` per agent, and resolves it as
        // config.plumbCommand -> $PLUMB_BIN -> `plumb` on PATH. Without this the
        // per-agent connections would not carry the scenario's isolation (its
        // private HOME, or its namespace token) and would join the developer's
        // real daemon as the default namespace.
        PLUMB_BIN: plumbSh,
        FAKE_MODEL_KEY: 'dsh-plumb-identity-e2e',
        DSH_PERMISSION_MODE: 'danger-full-access',
        NO_COLOR: '1',
        PLUMB_IDENTITY_DEBUG: process.env.PLUMB_IDENTITY_DEBUG ?? '',
      },
    })
    if (run.timedOut) console.error(`  dsh timed out after ${RUN_TIMEOUT_MS}ms`)
    console.log(`  dsh exit=${run.code}${run.timedOut ? ' (timed out)' : ''}`)

    // A run cut off by the timeout, or one that failed, is not a pass, whatever
    // records it left first. Teardown still runs in the finally below.
    const ran = !run.timedOut && run.code === 0
    const failure = run.timedOut
      ? `dsh did not finish within ${RUN_TIMEOUT_MS}ms`
      : run.code !== 0
        ? `dsh exited ${run.code}`
        : environment.beforeExpect() ?? (await scenario.expect({ source, fake, setup, gate }))
    // Checked whether or not the scenario's own assertions held: a serve that
    // never joined the namespace is the likeliest reason they did not, and the
    // leak is what explains it.
    const leak = ran ? environment.afterExpect() : null
    const problem = leak === null ? failure : failure === null ? leak : `${failure}; ${leak}`
    if (problem === null) {
      console.log(`  PASS ${mode}`)
      passed = true
    } else {
      console.error(`  FAIL ${mode}: ${problem}`)
    }
  } catch (error) {
    console.error(`  FAIL ${mode}: ${error.message}`)
  } finally {
    // End dsh and any serve it left before tearing the isolation down, or that
    // serve redials the daemon (in daemon mode: starts a new one). First, so a
    // fake model still holding a connection open cannot keep the teardown from
    // running.
    for (const problem of await endDshGroups()) {
      console.error(`  FAIL ${mode}: teardown: ${problem}`)
      passed = false
    }
    if (fake) await fake.close()
    // Daemon mode (PLAN-507): `plumb serve` daemonizes this scenario's plumb
    // daemon, so nothing above ends it. Stop it on pass AND fail, before its
    // HOME is deleted, and fail the scenario (keeping the root) unless teardown
    // can show no daemon is left; see isolated-daemon.mjs. Namespace mode: release
    // the scenario's namespace, which is all it ever held of the daemon.
    if (environment) {
      const { notes, problems } = await environment.teardown()
      for (const note of notes) console.log(`  teardown: ${note}`)
      for (const problem of problems) {
        console.error(`  FAIL ${mode}: teardown: ${problem}`)
        passed = false
      }
      liveEnvironments.delete(root)
    }
    if (passed && !keep) fs.rmSync(root, { recursive: true, force: true })
    else console.log(`  (kept for debugging: ${root})`)
  }
  return passed
}

/**
 * What a scenario's plumb is, in either isolation: the command every plumb
 * process goes through (`plumbSh`), where the assertions read plumb's records
 * (`source`), the two sanity checks around `expect`, and the teardown.
 *
 * `beforeExpect`/`afterExpect` return a problem or null. `teardown` resolves
 * `{ notes, problems }`, and is safe to call twice.
 */
function createEnvironment({ isolation, root, plumbBin }) {
  if (isolation.mode === 'daemon') {
    const plumbHome = path.join(root, 'plumbhome')
    let tornDown = null
    return {
      plumbSh: writePlumbWrapper({ root, plumbBin }),
      source: {
        records: () => readRecordsUnder(plumbHome),
        daemonLog: () => readDaemonLogUnder(plumbHome),
      },
      namespaceId: null,
      beforeExpect: () => null,
      afterExpect: () => null,
      teardown: () => {
        tornDown ??= stopIsolatedDaemon(plumbHome).then(({ stopped, problems }) => ({
          notes: stopped.length > 0 ? [`stopped the isolated plumb daemon (pid ${stopped.join(', ')})`] : [],
          problems,
        }))
        return tornDown
      },
    }
  }

  // Namespace mode: see createNamespaceEnvironment.
  return createNamespaceEnvironment({ ledger: isolation.ledger, files: isolation.files, root, plumbBin })
}

/**
 * Leave a note for whoever attaches to `workspace` next (PLAN-500's setup).
 * Returns the note's unique marker.
 */
async function fileWaitingNote({ workspace, plumbSh }) {
  const marker = `plan500-waiting-note-${process.pid}-${Date.now()}`
  await sendNote({ workspace, plumbSh, to: 'next', body: marker })
  console.log(`  setup: left a note for the next session (${marker})`)
  return { marker }
}

/**
 * PLAN-510's gate, run while the model is held between daemon_info and
 * check_messages: find the agent's own plumb session, send it a note while it
 * is connected (so the note is bound to that session), then wait until plumb
 * records the connection's end, which is the idle close. Releasing the gate
 * then makes the model's check_messages open a NEW connection.
 */
async function noteWhileConnectedThenReconnect({ source, workspace, plumbSh, idleMs, gate }) {
  const connected = await pollFor(() => agentRecords({ source }).find((r) => !r.ended), DECLARE_TIMEOUT_MS)
  if (!connected) throw new Error('the agent never opened its own plumb connection')
  gate.sessionId = connected.id
  gate.marker = `plan510-connected-note-${process.pid}-${Date.now()}`
  await sendNote({ workspace, plumbSh, to: connected.name, body: gate.marker })
  // The premise: the note went out while the session was live. A send that
  // outlasted the idle close would test a note to an ended session instead.
  if (agentRecords({ source }).some((r) => r.id === connected.id && r.ended)) {
    throw new Error(`session ${connected.id} had already ended when the note was sent; raise the scenario's idleMs`)
  }
  console.log(`  gate: sent a note to ${connected.name} (session ${connected.id}) while it is connected`)
  const ended = await pollFor(() => agentRecords({ source }).find((r) => r.id === connected.id && r.ended), idleMs + DECLARE_TIMEOUT_MS)
  if (!ended) throw new Error(`the agent's connection never idle-closed (session ${connected.id} has no end after ${idleMs + DECLARE_TIMEOUT_MS} ms)`)
  gate.ended = true
  console.log(`  gate: plumb recorded the end of session ${connected.id}; releasing the model's check_messages`)
}

/**
 * Send one note from a short-lived plumb session of its own (plumb's CLI
 * cannot send mail). Speaks MCP's stdio framing directly, one JSON-RPC message
 * per line, so the harness needs no SDK.
 */
async function sendNote({ workspace, plumbSh, to, body }) {
  const child = spawn(plumbSh, ['serve'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  const pending = new Map()
  let buffered = ''
  child.stdout.on('data', (data) => {
    buffered += data
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  let nextId = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out; plumb stderr: ${stderr.slice(-400)}`)), DECLARE_TIMEOUT_MS)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const toolCall = async (toolName, args) => {
    const reply = await call('tools/call', { name: toolName, arguments: args })
    if (reply.error || reply.result?.isError === true) {
      const why = reply.error?.message ?? (reply.result?.content ?? []).map((part) => part.text).join(' ')
      throw new Error(`${toolName} failed: ${String(why).slice(0, 300)}`)
    }
    return reply.result
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-identity-e2e-sender', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await toolCall('session_start', { session_id: 'dsh-identity-e2e-sender', workspace })
    await toolCall('leave_note', { to, body })
  } finally {
    child.stdin.end()
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 5_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

// -- throwaway environment ---------------------------------------------------------

function buildDshHome({ root, fakeUrl, plumbSh, hoisted, idleMs, perAgent }) {
  const home = path.join(root, 'dsh-home')
  const profile = path.join(home, 'profiles', 'e2e')
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(hoisted, path.join(home, 'profiles', 'node_modules'), 'dir')

  fs.writeFileSync(path.join(home, 'settings.yaml'), `\
# Throwaway DSH home for the dsh-plumb-identity e2e. The ONLY LLM provider is
# the local fake, so a misrouted model request fails fast instead of billing.
agent-default-model:
  provider: dsh-identity-fake
  model: fake-1
llm-pi-ai:
  providers:
    dsh-identity-fake:
      displayName: dsh-plumb-identity e2e fake
      apiKeyEnv: FAKE_MODEL_KEY
      api: openai-completions
      baseURL: ${fakeUrl}
      models:
        - id: fake-1
          name: Fake One
          contextWindow: 131072
          maxTokens: 8192
`)

  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-identity-e2e',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2)}\n`)

  // DSH 0.2 no longer reads settings.yaml at boot: it imports the file into the
  // profile only after the loader settles, so a fresh headless run starts on the
  // built-in default (deepseek-official) and fails MISSING_CREDENTIAL. The same
  // two sections as id-targeted rows of the home patch layer take effect at boot
  // on 0.2; settings.yaml above stays for 0.1.
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), `\
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dsh-identity-fake
    model: fake-1
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dsh-identity-fake:
        displayName: dsh-plumb-identity e2e fake
        apiKeyEnv: FAKE_MODEL_KEY
        api: openai-completions
        baseURL: ${fakeUrl}
        models:
          - id: fake-1
            name: Fake One
            contextWindow: 131072
            maxTokens: 8192
# Mounts the plugin from THIS checkout (the code under test) above the isolated
# plumb mcp-client row. Order is irrelevant to correctness — the plugin
# captures the plumb client during the SDK's tools sync — but matches the
# bundle-patch convention.
- insert:
    - id: dsh-plumb-identity
      name: '${`file://${PLUGIN_FILE}`}'
      config:
        serverName: plumb
        logEvents: true
        # E2E_PER_AGENT=0 runs the SAME scenario on the shared connection: the
        # control that proves the per-agent assertions fail if the feature
        # silently reverts to stamping.
        perAgentConnection: ${perAgent ? 'true' : 'false'}
        # 60 s here unless the scenario or E2E_IDLE_MS says otherwise (a
        # smaller value ends each run sooner); the production default is 15 s.
        idleMs: ${idleMs}
        # E2E_RESUME_PROOF=0 declares without plumb's resume proof: the
        # control that proves the reconnect scenario fails without it.
        resumeProof: ${process.env.E2E_RESUME_PROOF === '0' ? 'false' : 'true'}
        # E2E_NORMALISE=0 passes the model's own session_id through instead of
        # taking it over: the control that proves the declared-id scenario fails
        # without normalisation (PLAN-510).
        normaliseDeclarations: ${process.env.E2E_NORMALISE === '0' ? 'false' : 'true'}
    - id: mcp-plumb
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: plumb
        transport: stdio
        command: ${plumbSh}
        args:
          - serve
`)
  return home
}

/**
 * DAEMON ISOLATION ONLY (E2E_ISOLATION=daemon; namespace isolation has its own
 * wrapper, namespace-mode.mjs). The plumb side of the scenario must not touch
 * the developer's real daemon state, so the mcp row's command is a wrapper that
 * relocates every writable plumb root under the temp tree. It passes its
 * arguments through: the plugin runs it as `serve` and, for the resume proof, as
 * `hooks run-claude`, whose key must be this scenario's too. TSM_ORIG_*
 * companions are stripped because plumb's session-manager hijack recovery would
 * otherwise see a temp XDG override and "recover" it back at the real user state.
 *
 * plumb 0.25 resolves its daemon's directories from the OS account and refuses to
 * launch one without an installed service profile, ignoring every HOME and XDG_*
 * set here ("serve: ignoring this client's environment for a global directory").
 * PLUMB_ACCOUNT_AUTHORITY=false is its documented opt-out: the environment-derived
 * directories and this binary as the daemon, which is what a daemon per scenario
 * needs. Older plumb ignores the variable.
 */
function writePlumbWrapper({ root, plumbBin }) {
  const home = path.join(root, 'plumbhome')
  const xdg = (base) => path.join(home, base)
  const wrapper = path.join(root, 'plumb-isolated.sh')
  fs.writeFileSync(wrapper, `\
#!/bin/sh
# Generated by test/e2e-mock-provider.mjs — isolated plumb serve.
HOME='${home}'
export HOME
XDG_CONFIG_HOME='${xdg('.config')}'
XDG_DATA_HOME='${xdg('.local/share')}'
XDG_STATE_HOME='${xdg('.local/state')}'
XDG_CACHE_HOME='${xdg('.cache')}'
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
PLUMB_ACCOUNT_AUTHORITY=false
export PLUMB_ACCOUNT_AUTHORITY
unset TSM_ORIG_HOME TSM_ORIG_XDG_CONFIG_HOME TSM_ORIG_XDG_DATA_HOME TSM_ORIG_XDG_STATE_HOME TSM_ORIG_XDG_CACHE_HOME
# On Linux a usable XDG_RUNTIME_DIR wins over HOME for the daemon's socket and
# lock, which would put this daemon beside the user's real one.
unset XDG_RUNTIME_DIR
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \\
  "$HOME/Library/Caches" "$HOME/Library/Logs"
exec '${plumbBin}' "$@"
`)
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

// -- plumb-side assertions ---------------------------------------------------------

/**
 * Wait until a session record satisfying `predicate` shows up in the scenario's
 * plumb state — plumb writes the declaration server-side during the run, so
 * after the dsh process exits it is a short bounded wait at most.
 */
async function pollForDeclared(ctx, predicate) {
  const deadline = Date.now() + DECLARE_TIMEOUT_MS
  for (;;) {
    const hit = readSessionRecords(ctx).find(predicate)
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await sleep(500)
  }
}

/**
 * Every declared-session record the scenario's session source can see: the
 * isolated daemon's private state, or the shared daemon's records of the
 * scenario's own namespace (see session-records.mjs and namespace-mode.mjs).
 */
function readSessionRecords(ctx) {
  return ctx.source.records()
}

/**
 * The main agent's DECLARED sessions: its own-connection records that carry
 * its external id. A reconnecting serve also leaves a short-lived record with
 * no external id: the session it was given on connect, ended within
 * milliseconds when its session_start resumed the agent's own. That record is
 * the connection, not the agent, so it is not one of these.
 */
function agentRecords(ctx) {
  return readSessionRecords(ctx).filter((r) => r.clientName === 'dsh-plumb-identity' && r.purpose === 'dsh' && r.isIdentity && r.id !== null)
}

/** Poll `probe` until it returns something truthy, or null at the deadline. */
async function pollFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await sleep(250)
  }
}

// -- process + path resolution helpers ----------------------------------------------

/** Resolve the dsh launcher: DSH_BIN, else the profile tree dsh itself uses. */
function resolveHarness() {
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  candidates.push(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const bin = candidates.find((p) => fs.existsSync(p))
  if (!bin) {
    throw new Error('no dsh install found — set DSH_BIN to your dsh launcher (or dsh lib/bin.js)')
  }
  const hoisted = nearestNodeModules(bin)
  if (!hoisted) {
    throw new Error(`cannot locate the hoisted profile node_modules above ${bin} — set DSH_BIN to a path under the profile tree`)
  }
  return {
    label: bin,
    bin,
    hoisted,
    argv: (args) => (bin.endsWith('.js') ? [process.execPath, bin, ...args] : [bin, ...args]),
  }
}

function nearestNodeModules(from) {
  let dir = path.dirname(path.resolve(from))
  for (let i = 0; i < 8 && dir !== path.parse(dir).root; i += 1) {
    if (path.basename(dir) === 'node_modules') return dir
    dir = path.dirname(dir)
  }
  return null
}

/** Resolve the plumb binary: PLUMB_BIN, ../plumb/plumb, or PATH. Once: the host decision and the run use the same one. */
function resolvePlumb() {
  resolvedPlumb ??= findPlumb()
  return resolvedPlumb
}

function findPlumb() {
  const candidates = [
    process.env.PLUMB_BIN,
    path.join(REPO_ROOT, '..', 'plumb', 'plumb'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const onPath = spawnSync('plumb', ['version'], { encoding: 'utf8' })
  if (!onPath.error) return 'plumb'
  throw new Error('no plumb binary found — set PLUMB_BIN (the e2e drives a real, isolated `plumb serve`)')
}

/**
 * Run the dsh launcher to completion, streaming its output through with a
 * scenario prefix, and enforce the run timeout. dsh runs in its own process
 * group, recorded in `liveGroups`, so teardown can end it together with every
 * `plumb serve` it started: a serve left running redials the daemon teardown
 * stops and starts a new one.
 */
function runDsh(harness, args, { cwd, env, timeoutMs }) {
  const [file, ...spawnArgs] = harness.argv(args)
  return new Promise((resolve) => {
    const child = spawn(file, spawnArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    if (child.pid) liveGroups.add(child.pid)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
      process.stdout.write(`${data}`)
    })
    child.stderr.on('data', (data) => {
      stderr += data
      process.stderr.write(`${data}`)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error(`  dsh spawn failed: ${error.message}`)
      resolve({ code: 1, stdout, stderr, timedOut })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
