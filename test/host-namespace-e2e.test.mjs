// The e2e's host decision (test/separate-env.mjs hostDecision, wired in
// e2e-mock-provider.mjs) as a child process. The only plumb it can reach is a FAKE
// one, a shell script that prints canned output and logs its arguments, so nothing
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
import { separateEnvironment } from './separate-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'host-namespace-vectors.json'), 'utf8'))

const REAL_LISTING = VECTORS.parserCases[0].lines.join('\n')
const listing = (name) => VECTORS.parserCases.find((c) => c.name === name).lines.join('\n')
// What plumb prints for two daemons (a VIOLATION verdict), and the same table trimmed of its verdict.
const TWO_LISTING = listing('two daemons: the authority holder and a stray, under a VIOLATION verdict')
const TWO_UNJUDGED = listing('two daemons with no verdict line (a trimmed listing): both rows are read')

/**
 * A plumb that only prints and logs (POSIX shell builtins, so it needs no PATH).
 * It answers exactly the three read-only commands the decision runs, and exits 1
 * with "unknown command" for anything else, which the log then shows. `listing`
 * is what `plumb debug daemons` prints; `daemonsExit` its exit status; `help` and
 * `list` the namespace probe.
 */
function fakePlumb(dir, { listing = REAL_LISTING, daemonsExit = 0, help = 0, list = 0 } = {}) {
  const log = path.join(dir, 'plumb-calls.log')
  const listingFile = path.join(dir, 'listing.txt')
  fs.writeFileSync(listingFile, `${listing}\n`)
  const bin = path.join(dir, 'plumb')
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1:$2:$3" in',
    `  namespace:--help:*) printf 'create renew release list\\n'; exit ${help} ;;`,
    `  namespace:list:--json) printf 'null\\n'; exit ${list} ;;`,
    `  debug:daemons:) while IFS= read -r line; do printf '%s\\n' "$line"; done < '${listingFile}'; exit ${daemonsExit} ;;`,
    'esac',
    "printf 'unknown command\\n' >&2",
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}

// A preload that records how many signal handlers the process holds when it exits.
const LISTENER_PROBE = path.join(HERE, 'fixtures', 'listener-probe.mjs')

function runE2E(t, { env: extra = {}, args = [], plumb = {} } = {}) {
  const env = { ...process.env }
  for (const key of ['GITHUB_ACTIONS', 'PLUMB_SEPARATE_ENV', 'E2E_ISOLATION', 'PLUMB_NAMESPACE', 'DSH_E2E_HOST_DAEMON']) delete env[key]
  if (separateEnvironment({ env }) !== null) {
    t.skip('this process runs in a container')
    return null
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostns-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fake = fakePlumb(dir, plumb)
  const before = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-')))
  Object.assign(env, extra)
  // Nothing past the decision can resolve: no dsh, and the only plumb is the fake.
  env.DSH_BIN = '/nonexistent/dsh'
  env.DSH_HOME = path.join(dir, 'dsh-home')
  env.PLUMB_BIN = fake.bin
  env.PATH = '/nonexistent'
  const probeOut = path.join(dir, 'signal-listeners.json')
  env.LISTENER_PROBE_OUT = probeOut
  const run = spawnSync(process.execPath, ['--import', LISTENER_PROBE, path.join(HERE, 'e2e-mock-provider.mjs'), ...args], { env, encoding: 'utf8', timeout: 30_000 })
  const created = fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-') && !before.has(n))
  // [SIGINT, SIGTERM, SIGHUP] handlers held at exit; null if the probe never wrote.
  const listeners = fs.existsSync(probeOut) ? JSON.parse(fs.readFileSync(probeOut, 'utf8')) : null
  return { run, calls: fake.calls(), created, listeners }
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

test('the e2e on a host with the opt-in for the one authority daemon: --isolation and --list run, after three read-only plumb commands', (t) => {
  for (const args of [['--isolation'], ['--list']]) {
    const r = runE2E(t, { env: { DSH_E2E_HOST_DAEMON: '48103' }, args })
    if (r === null) return
    assert.equal(r.run.status, 0, `${args}: exit ${r.run.status}\n${r.run.stdout}\n${r.run.stderr}`)
    assert.match(r.run.stdout, /^e2e: running on the developer host in namespace isolation against plumb daemon 48103/m)
    if (args[0] === '--isolation') assert.match(r.run.stdout, /^namespace$/m)
    else assert.match(r.run.stdout, /^tool-call$/m)
    assert.deepEqual(r.calls, READ_ONLY, 'only the probe and the listing ran: no namespace create, no restart')
    assert.deepEqual(r.created, [], 'no scenario root was created')
    assert.deepEqual(r.listeners, [1, 1, 1], 'an accepted run installs the teardown handler (so the zero below means something)')
  }
})

const REFUSED_HOST_CASES = [
  { name: 'a PID that is not the daemon\'s', env: { DSH_E2E_HOST_DAEMON: '48104' }, calls: READ_ONLY, why: /48104.*48103/s },
  { name: 'a stale recipe: a PID with a leading zero', env: { DSH_E2E_HOST_DAEMON: '048103' }, calls: [], why: /plain decimal PID/ },
  { name: 'an empty opt-in', env: { DSH_E2E_HOST_DAEMON: '' }, calls: [], why: /plain decimal PID/ },
  { name: 'daemon isolation', env: { DSH_E2E_HOST_DAEMON: '48103', E2E_ISOLATION: 'daemon' }, calls: [], why: /namespace isolation only/ },
  { name: 'an unknown isolation', env: { DSH_E2E_HOST_DAEMON: '48103', E2E_ISOLATION: 'bogus' }, calls: [], why: /bogus/ },
  { name: 'a plumb without namespaces', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { help: 1 }, calls: ['namespace --help'], why: /capability probe/ },
  { name: 'a daemon that does not answer namespace commands', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { list: 1 }, calls: ['namespace --help', 'namespace list --json'], why: /capability probe/ },
  { name: 'two daemons, as plumb reports them', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_LISTING, daemonsExit: 1 }, calls: READ_ONLY, why: /verdict was not OK/ },
  { name: 'two daemons under a VIOLATION verdict, even when the census exits 0', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_LISTING }, calls: READ_ONLY, why: /verdict was not OK/ },
  { name: 'two daemons with no verdict line, when the census exits 0', env: { DSH_E2E_HOST_DAEMON: '48103' }, plumb: { listing: TWO_UNJUDGED }, calls: READ_ONLY, why: /lists 2 daemons/ },
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
      assert.equal(r.run.stdout.trim(), '', 'a refused run prints nothing on stdout')
      assert.deepEqual(r.calls, c.calls)
      assert.deepEqual(r.created, [], 'no scenario root was created')
      assert.deepEqual(r.listeners, [0, 0, 0], 'no signal handler was installed')
    })
  }
}
