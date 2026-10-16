// The e2e's host decision (test/separate-env.mjs hostDecision, wired in
// e2e-mock-provider.mjs) as a child process. The only plumb it can reach is a FAKE
// one (fake-plumb.mjs), a shell script that prints canned output and logs its arguments, so nothing
// here starts, stops, signals or talks to a real daemon; and every run stops at the
// decision or at --list/--isolation, which print and exit before a scenario root,
// a namespace or a harness exists.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FAKE_VERSION, fakePlumb } from './fake-plumb.mjs'
import { separateEnvironment } from './separate-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'host-namespace-vectors.json'), 'utf8'))

const REAL_LISTING = VECTORS.parserCases[0].lines.join('\n')
const listing = (name) => VECTORS.parserCases.find((c) => c.name === name).lines.join('\n')
// What plumb prints for two daemons (a VIOLATION verdict), and the same table trimmed of its verdict.
const TWO_LISTING = listing('two daemons: the authority holder and a stray, under a VIOLATION verdict')
const TWO_UNJUDGED = listing('two daemons with no verdict line (a trimmed listing): both rows are read')
// The real listing with its verdict line cut: the table alone reads as the right daemon.
const ONE_UNJUDGED = REAL_LISTING.split('\n').filter((line) => !/^(\x1b\[[0-9;]*m)?OK(\x1b\[[0-9;]*m)? — /.test(line)).join('\n')

// A preload that records how many signal handlers the process holds when it exits.
const LISTENER_PROBE = path.join(HERE, 'fixtures', 'listener-probe.mjs')

function runE2E(t, { env: extra = {}, args = [], plumb = {}, dsh = false } = {}) {
  const env = { ...process.env }
  for (const key of ['GITHUB_ACTIONS', 'PLUMB_SEPARATE_ENV', 'E2E_ISOLATION', 'PLUMB_NAMESPACE', 'DSH_E2E_HOST_DAEMON']) delete env[key]
  if (separateEnvironment({ env }) !== null) {
    t.skip('this process runs in a container')
    return null
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostns-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { listing = REAL_LISTING, listings = [listing], ...options } = plumb
  const fake = fakePlumb(dir, { listings, ...options })
  const before = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-')))
  Object.assign(env, extra)
  // Nothing past the decision can resolve: no dsh, and the only plumb is the fake.
  env.DSH_BIN = '/nonexistent/dsh'
  env.DSH_HOME = path.join(dir, 'dsh-home')
  env.PLUMB_BIN = fake.bin
  env.PATH = '/nonexistent'
  if (dsh) {
    // A dsh that does nothing and exits 0, under a node_modules directory as the
    // harness expects. With it a scenario runs to its assertions (which fail: the
    // fake daemon has no session records) and its namespace is created and released.
    const hoisted = path.join(dir, 'node_modules')
    fs.mkdirSync(path.join(hoisted, 'fake-dsh'), { recursive: true })
    env.DSH_BIN = path.join(hoisted, 'fake-dsh', 'dsh')
    fs.writeFileSync(env.DSH_BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const probeOut = path.join(dir, 'signal-listeners.json')
  env.LISTENER_PROBE_OUT = probeOut
  const run = spawnSync(process.execPath, ['--import', LISTENER_PROBE, path.join(HERE, 'e2e-mock-provider.mjs'), ...args], { env, encoding: 'utf8', timeout: 30_000 })
  const created = fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-') && !before.has(n))
  // Roots a failed scenario keeps for debugging are this test's to remove.
  if (dsh) t.after(() => created.forEach((name) => fs.rmSync(path.join('/tmp', name), { recursive: true, force: true })))
  // [SIGINT, SIGTERM, SIGHUP] handlers held at exit; null if the probe never wrote.
  const listeners = fs.existsSync(probeOut) ? JSON.parse(fs.readFileSync(probeOut, 'utf8')) : null
  return { run, calls: fake.calls(), created, listeners, bin: fake.bin }
}

const READ_ONLY = ['namespace --help', 'namespace list --json', 'debug daemons']

for (const args of [['--mode', 'tool-call'], ['--isolation'], ['--list']]) {
  test(`the e2e on a plain host, without the opt-in, still refuses before it asks plumb anything (${args.join(' ')})`, (t) => {
    const r = runE2E(t, { args })
    if (r === null) return
    assert.equal(r.run.status, 2, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
    assert.match(r.run.stderr, /refusing to run here/)
    assert.match(r.run.stderr, /not to start, stop or write namespaces into/)
    assert.doesNotMatch(r.run.stderr, /was not accepted/, 'the early refusal, not the opt-in\'s')
    assert.equal(r.run.stdout.trim(), '')
    assert.deepEqual(r.calls, [], 'the fake plumb was never run')
    assert.deepEqual(r.created, [], 'no scenario root was created')
    assert.deepEqual(r.listeners, [0, 0, 0], 'no signal handler was installed')
  })
}

// Separate evidence still decides on its own. GITHUB_ACTIONS=true is accepted on any
// OS, so this runs the real decision on a host with only --list/--isolation, which
// print and exit before anything is created.
for (const args of [['--isolation'], ['--list']]) {
  test(`the e2e with separate-environment evidence is allowed without the opt-in and asks plumb nothing (${args.join(' ')})`, (t) => {
    const r = runE2E(t, { env: { GITHUB_ACTIONS: 'true' }, args })
    if (r === null) return
    assert.equal(r.run.status, 0, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
    assert.doesNotMatch(r.run.stdout, /developer host/)
    assert.deepEqual(r.calls, [], 'the fake plumb was never run')
    assert.deepEqual(r.created, [])
    assert.deepEqual(r.listeners, [1, 1, 1])
  })
}

test('the e2e on a host with the opt-in for the one authority daemon: --isolation and --list run, after four read-only plumb commands', (t) => {
  for (const args of [['--isolation'], ['--list']]) {
    const r = runE2E(t, { env: { DSH_E2E_HOST_DAEMON: '48103' }, args })
    if (r === null) return
    assert.equal(r.run.status, 0, `${args}: exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
    assert.match(r.run.stdout, /^e2e: running on the developer host in namespace isolation against plumb daemon 48103/m)
    if (args[0] === '--isolation') assert.match(r.run.stdout, /^namespace$/m)
    else assert.match(r.run.stdout, /^tool-call$/m)
    assert.ok(r.run.stdout.includes(`; plumb binary ${r.bin}, ${FAKE_VERSION}\n`), `the acceptance line names the plumb binary and its version\n${r.run.stdout}`)
    assert.deepEqual(r.calls, [...READ_ONLY, 'version'], 'only the probe, the listing and the version ran: no namespace create, no restart')
    assert.deepEqual(r.created, [], 'no scenario root was created')
    assert.deepEqual(r.listeners, [1, 1, 1], 'an accepted run installs the teardown handler (so the zero below means something)')
  }
})

test('a plumb whose `version` fails is not believed, even if it printed a line first', (t) => {
  const r = runE2E(t, { env: { DSH_E2E_HOST_DAEMON: '48103' }, args: ['--list'], plumb: { versionExit: 1 } })
  if (r === null) return
  assert.equal(r.run.status, 0, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
  assert.ok(r.run.stdout.includes(`; plumb binary ${r.bin}, version unknown\n`), r.run.stdout)
})

test('a plumb that will not say its version is still accepted, and the line says so', (t) => {
  const r = runE2E(t, { env: { DSH_E2E_HOST_DAEMON: '48103' }, args: ['--list'], plumb: { version: null } })
  if (r === null) return
  assert.equal(r.run.status, 0, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
  assert.ok(r.run.stdout.includes(`; plumb binary ${r.bin}, version unknown\n`), r.run.stdout)
  assert.deepEqual(r.calls, [...READ_ONLY, 'version'])
})

// The daemon is looked at again before every namespace the run creates. The fake's
// n-th `debug daemons` prints the n-th listing: the 1st is the decision, the 2nd
// the re-check before the first scenario, the 3rd before the second.
const OWNER = { DSH_E2E_HOST_DAEMON: '48103' }
const REPLACED = listing('one daemon, a different PID: the owner\'s was replaced')
const THREE = ['--mode', 'text-only', '--mode', 'text-only', '--mode', 'text-only']
const countOf = (calls, prefix) => calls.filter((c) => c === prefix || c.startsWith(`${prefix} `)).length

test('the e2e re-checks the daemon before each namespace: a replaced daemon gets none, and the run stops', (t) => {
  const r = runE2E(t, { env: OWNER, args: THREE, plumb: { listings: [REAL_LISTING, REAL_LISTING, REPLACED] }, dsh: true })
  if (r === null) return
  assert.equal(r.run.status, 1, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
  assert.equal(countOf(r.calls, 'debug daemons'), 3, 'the decision and one re-check per scenario started')
  assert.equal(countOf(r.calls, 'namespace create'), 1, 'only the first scenario got a namespace')
  assert.equal(countOf(r.calls, 'namespace release'), 1, 'and released it')
  assert.equal((r.run.stdout.match(/=== text-only ===/g) ?? []).length, 2, 'the third scenario never started')
  assert.match(r.run.stderr, /e2e: STOPPED: .*48103.*is not the PID of the one running daemon/s)
  // The new daemon's PID is not handed out: whoever re-runs reads it from the daemon.
  assert.doesNotMatch(r.run.stderr, /51000/)
  assert.doesNotMatch(r.run.stderr, /never released/, 'nothing it held was left active')
})

test('a stopped run releases a namespace its scenario could not (and says so)', (t) => {
  // The first scenario's own release fails; the run stops before the second; the
  // stop retries the release, which this time succeeds.
  const r = runE2E(t, { env: OWNER, args: THREE, plumb: { listings: [REAL_LISTING, REAL_LISTING, REPLACED], releaseFails: 1 }, dsh: true })
  if (r === null) return
  assert.equal(r.run.status, 1, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
  assert.equal(countOf(r.calls, 'namespace create'), 1)
  assert.equal(countOf(r.calls, 'namespace release'), 2, 'the scenario\'s release, then the stop\'s retry')
  assert.match(r.run.stderr, /released namespace ns-fake1/)
  assert.match(r.run.stderr, /e2e: STOPPED: /)
  assert.doesNotMatch(r.run.stderr, /never released/)
})

test('the e2e re-checks before the FIRST namespace too: a daemon replaced since the decision gets none', (t) => {
  const r = runE2E(t, { env: OWNER, args: THREE, plumb: { listings: [REAL_LISTING, REPLACED] }, dsh: true })
  if (r === null) return
  assert.equal(r.run.status, 1, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
  assert.equal(countOf(r.calls, 'namespace create'), 0)
  assert.equal(countOf(r.calls, 'namespace release'), 0)
  assert.equal((r.run.stdout.match(/=== text-only ===/g) ?? []).length, 1)
  assert.match(r.run.stderr, /e2e: STOPPED: /)
  assert.deepEqual(r.created, [], 'the scenario that was refused left no root behind')
})

test('the e2e re-checks and carries on while the daemon is unchanged (the control)', (t) => {
  const r = runE2E(t, { env: OWNER, args: ['--mode', 'text-only', '--mode', 'text-only'], plumb: { listings: [REAL_LISTING] }, dsh: true })
  if (r === null) return
  assert.equal(countOf(r.calls, 'debug daemons'), 3)
  assert.equal(countOf(r.calls, 'namespace create'), 2)
  assert.equal(countOf(r.calls, 'namespace release'), 2)
  assert.equal((r.run.stdout.match(/=== text-only ===/g) ?? []).length, 2)
  assert.doesNotMatch(r.run.stderr, /STOPPED/)
})

test('separate-environment evidence needs no re-check: no listing is read before a namespace', (t) => {
  const r = runE2E(t, { env: { GITHUB_ACTIONS: 'true' }, args: ['--mode', 'text-only', '--mode', 'text-only'], dsh: true })
  if (r === null) return
  assert.equal(countOf(r.calls, 'debug daemons'), 0)
  assert.equal(countOf(r.calls, 'namespace create'), 2)
})

const REFUSED_HOST_CASES = [
  { name: 'a PID that is not the daemon\'s', env: { DSH_E2E_HOST_DAEMON: '48104' }, calls: READ_ONLY, why: /48104 is not the PID of the one running daemon/, hidden: /48103/ },
  { name: 'a stale recipe: a PID with a leading zero', env: { DSH_E2E_HOST_DAEMON: '048103' }, calls: [], why: /plain decimal PID/ },
  { name: 'an empty opt-in', env: { DSH_E2E_HOST_DAEMON: '' }, calls: [], why: /plain decimal PID/ },
  { name: 'daemon isolation', env: { DSH_E2E_HOST_DAEMON: '48103', E2E_ISOLATION: 'daemon' }, calls: [], why: /namespace isolation only/ },
  { name: 'an unknown isolation', env: { DSH_E2E_HOST_DAEMON: '48103', E2E_ISOLATION: 'bogus' }, calls: [], why: /bogus/ },
  { name: 'a plumb without namespaces', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { help: 1 }, calls: ['namespace --help'], why: /capability probe/ },
  { name: 'a daemon that does not answer namespace commands', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { list: 1 }, calls: ['namespace --help', 'namespace list --json'], why: /capability probe/ },
  { name: 'two daemons, as plumb reports them', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_LISTING, daemonsExit: 1 }, calls: READ_ONLY, why: /verdict was not OK/ },
  { name: 'two daemons under a VIOLATION verdict, even when the census exits 0', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_LISTING }, calls: READ_ONLY, why: /verdict was not OK/ },
  { name: 'two daemons with no verdict line, when the census exits 0', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_UNJUDGED }, calls: READ_ONLY, why: /had no verdict line/ },
  { name: 'the right daemon with no verdict line, when the census exits 0', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: ONE_UNJUDGED }, calls: READ_ONLY, why: /had no verdict line/ },
  { name: 'a census that exits non-zero over a listing of the right daemon', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { daemonsExit: 1 }, calls: READ_ONLY, why: /plumb debug daemons/ },
  { name: 'a listing that cannot be read', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: 'hello' }, calls: READ_ONLY, why: /plumb debug daemons/ },
]

for (const c of REFUSED_HOST_CASES) {
  for (const args of [['--mode', 'tool-call'], ['--list']]) {
    test(`the e2e on a host with the opt-in refuses before it creates anything: ${c.name} (${args.join(' ')})`, (t) => {
      const r = runE2E(t, { env: c.env, args, plumb: c.plumb })
      if (r === null) return
      assert.equal(r.run.status, 2, `exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
      assert.match(r.run.stderr, /refusing to run here/)
      assert.match(r.run.stderr, /not to start, stop or write namespaces into/)
      assert.match(r.run.stderr, c.why)
      if (c.hidden) assert.doesNotMatch(r.run.stderr, c.hidden, 'the refusal does not hand out the daemon\'s PID')
      assert.equal(r.run.stdout.trim(), '', 'a refused run prints nothing on stdout')
      assert.deepEqual(r.calls, c.calls)
      assert.deepEqual(r.created, [], 'no scenario root was created')
      assert.deepEqual(r.listeners, [0, 0, 0], 'no signal handler was installed')
    })
  }
}
