// Namespace isolation for the e2e (test/namespace-mode.mjs), PLAN-520 slice C.
//
// No daemon and no plumb: every command is a stub that records what it was run
// with, so what is pinned here is the logic: which isolation a run takes, when a
// plumb is refused, that every token a run holds is released however it ends, and
// that a scenario's serves are given exactly the namespace and nothing else.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  classifyBinaryProbe, classifyDaemonProbe, createNamespaceEnvironment, createNamespaceLedger, DEFAULT_ISOLATION, describeProbeFailure,
  installExitRelease, ISOLATION_MODES, namespaceSource, namespaceWrapperScript, NamespaceUnavailable, parseJsonOutput, parseServiceDirs,
  probeNamespaceSupport, resolveDaemonFiles, resolveIsolation, runPlumb, selectIsolation, writeNamespaceWrapper,
} from './namespace-mode.mjs'

const ok = (stdout = '', stderr = '') => ({ status: 0, signal: null, stdout, stderr, error: null })
const failed = (stderr, status = 1) => ({ status, signal: null, stdout: '', stderr, error: null })

const HELP = 'Create and manage namespaces\n\nAvailable Commands:\n  create      Create a namespace and print its token\n  list        List namespaces\n  release     Release a namespace\n  renew       Renew a namespace\n'
const TOKEN = 'pns1-SECRETSECRETSECRET'

// -- the isolation ------------------------------------------------------------------------

test('selectIsolation: namespace unless asked otherwise', () => {
  assert.deepEqual(selectIsolation({}), { mode: 'namespace', explicit: false })
  assert.deepEqual(selectIsolation({ E2E_ISOLATION: '' }), { mode: 'namespace', explicit: false })
  assert.equal(DEFAULT_ISOLATION, 'namespace')
  assert.deepEqual(ISOLATION_MODES, ['namespace', 'daemon'])
})

test('selectIsolation: the older isolation is chosen only by naming it', () => {
  assert.deepEqual(selectIsolation({ E2E_ISOLATION: 'daemon' }), { mode: 'daemon', explicit: true })
  assert.deepEqual(selectIsolation({ E2E_ISOLATION: 'namespace' }), { mode: 'namespace', explicit: true })
})

test('selectIsolation: anything else is an error, never a quiet default', () => {
  for (const bad of ['Namespace', 'DAEMON', 'isolated', 'none', '0', 'namespace ', 'ns']) {
    assert.throws(() => selectIsolation({ E2E_ISOLATION: bad }), /is not an isolation/, JSON.stringify(bad))
  }
})

// -- running plumb --------------------------------------------------------------------------

test('runPlumb drops an ambient PLUMB_NAMESPACE unless the caller names one', () => {
  const seen = []
  const spawn = (file, args, options) => { seen.push({ file, args, env: options.env }); return { status: 0, stdout: '', stderr: '' } }
  const before = process.env.PLUMB_NAMESPACE
  process.env.PLUMB_NAMESPACE = 'pns1-ambient'
  try {
    runPlumb('plumb', ['namespace', 'list'], { spawn })
    runPlumb('plumb', ['namespace', 'release'], { env: { PLUMB_NAMESPACE: 'pns1-given' }, spawn })
  } finally {
    if (before === undefined) delete process.env.PLUMB_NAMESPACE
    else process.env.PLUMB_NAMESPACE = before
  }
  assert.equal(seen[0].env.PLUMB_NAMESPACE, undefined, 'a run inside a namespace must not create its scenarios\' namespaces there')
  assert.equal(seen[1].env.PLUMB_NAMESPACE, 'pns1-given')
})

test('parseJsonOutput: a document, `null`, and text that is neither', () => {
  assert.deepEqual(parseJsonOutput('{"a": 1}\n'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseJsonOutput('[\n  {"id": "ns-1"}\n]\n'), { ok: true, value: [{ id: 'ns-1' }] })
  assert.deepEqual(parseJsonOutput('null\n'), { ok: true, value: null })
  assert.deepEqual(parseJsonOutput('note: starting\n{"a": 2}'), { ok: true, value: { a: 2 } })
  assert.equal(parseJsonOutput('no namespaces').ok, false)
  assert.equal(parseJsonOutput('{"a": ').ok, false)
  assert.equal(parseJsonOutput('').ok, false)
})

// -- the capability probe ---------------------------------------------------------------------

test('classifyBinaryProbe: a build that lists the four namespace commands', () => {
  assert.deepEqual(classifyBinaryProbe(ok(HELP)), { ok: true })
})

test('classifyBinaryProbe: a build without `plumb namespace` is not capable', () => {
  const probe = classifyBinaryProbe(failed('Error: unknown command "namespace" for "plumb"\nRun \'plumb --help\' for usage.'))
  assert.equal(probe.ok, false)
  assert.equal(probe.kind, 'binary')
  assert.match(probe.detail, /unknown command "namespace"/)
})

test('classifyBinaryProbe: exit 0 is not enough: the four commands must be listed', () => {
  for (const missing of ['create', 'renew', 'release', 'list']) {
    const help = HELP.replace(new RegExp(`\\b${missing}\\b`, 'g'), 'x')
    const probe = classifyBinaryProbe(ok(help))
    assert.equal(probe.ok, false, `without ${missing}`)
    assert.match(probe.detail, new RegExp(missing))
  }
  assert.equal(classifyBinaryProbe(ok('plumb: usage')).ok, false, 'a root help page that exits 0')
})

test('classifyBinaryProbe: a binary that cannot be run, or was killed, is not capable', () => {
  const error = Object.assign(new Error('spawn plumb ENOENT'), { code: 'ENOENT' })
  assert.equal(classifyBinaryProbe({ status: null, signal: null, stdout: '', stderr: '', error }).ok, false)
  assert.equal(classifyBinaryProbe({ status: null, signal: 'SIGTERM', stdout: HELP, stderr: '', error: null }).ok, false)
})

test('classifyDaemonProbe: a daemon that lists namespaces, none printing as null', () => {
  assert.deepEqual(classifyDaemonProbe(ok('null\n')), { ok: true, namespaces: [] })
  assert.deepEqual(classifyDaemonProbe(ok('[]')), { ok: true, namespaces: [] })
  const one = [{ id: 'ns-1a2b3c4d', state: 'active' }]
  assert.deepEqual(classifyDaemonProbe(ok(JSON.stringify(one, null, 2))), { ok: true, namespaces: one })
})

test('classifyDaemonProbe: a daemon an older build left running is told apart from no daemon', () => {
  const old = classifyDaemonProbe(failed('Error: the daemon does not support namespaces (reply "unknown command"); update and restart it'))
  assert.equal(old.ok, false)
  assert.equal(old.kind, 'daemon-old')
  assert.match(old.detail, /does not support namespaces/)
  const none = classifyDaemonProbe(failed('Error: dial unix /root/.local/state/plumb/plumb.sock: connect: no such file or directory'))
  assert.equal(none.ok, false)
  assert.equal(none.kind, 'daemon-unreachable')
})

test('classifyDaemonProbe: exit 0 with something that is not a list is not a daemon\'s answer', () => {
  for (const stdout of ['', 'ns-1 active', '{"namespaces": []}', '"text"', '7']) {
    const probe = classifyDaemonProbe(ok(stdout))
    assert.equal(probe.ok, false, JSON.stringify(stdout))
    assert.equal(probe.kind, 'daemon-unreachable')
  }
})

test('probeNamespaceSupport asks the binary first, and a failing binary never reaches the daemon', () => {
  const calls = []
  const run = (bin, args) => { calls.push([bin, ...args]); return args[1] === '--help' ? failed('Error: unknown command "namespace" for "plumb"') : ok('null') }
  const probe = probeNamespaceSupport('/opt/plumb', { run })
  assert.equal(probe.ok, false)
  assert.equal(probe.kind, 'binary')
  assert.deepEqual(calls, [['/opt/plumb', 'namespace', '--help']], 'the daemon command must not run against a build that cannot have it')
})

test('probeNamespaceSupport: a capable binary and a daemon that answers', () => {
  const calls = []
  const run = (bin, args) => { calls.push(args.join(' ')); return args[1] === '--help' ? ok(HELP) : ok('null') }
  assert.deepEqual(probeNamespaceSupport('/opt/plumb', { run }), { ok: true, namespaces: [] })
  assert.deepEqual(calls, ['namespace --help', 'namespace list --json'])
})

test('probeNamespaceSupport: a capable binary with no daemon is refused, not started', () => {
  const run = (bin, args) => (args[1] === '--help' ? ok(HELP) : failed('Error: no plumb daemon is running'))
  const probe = probeNamespaceSupport('/opt/plumb', { run })
  assert.equal(probe.ok, false)
  assert.equal(probe.kind, 'daemon-unreachable')
})

test('describeProbeFailure: what is wrong, what to do, and that nothing fell back', () => {
  for (const kind of ['binary', 'daemon-old', 'daemon-unreachable']) {
    const message = describeProbeFailure({ ok: false, kind, detail: 'why it failed' })
    assert.match(message, /namespace isolation is unavailable: why it failed/)
    assert.match(message, /Refusing to fall back to a daemon per scenario/)
    assert.match(message, /E2E_ISOLATION=daemon/)
  }
  assert.match(describeProbeFailure({ kind: 'binary', detail: 'x' }), /no `plumb namespace` command/)
  assert.match(describeProbeFailure({ kind: 'daemon-old', detail: 'x' }), /predates namespaces/)
  assert.match(describeProbeFailure({ kind: 'daemon-unreachable', detail: 'x' }), /never starts one itself/)
})

// -- tokens ---------------------------------------------------------------------------------------

/** A fake plumb: records every call, answers create and release the way plumb does. */
function fakePlumb({ id = 'ns-1a2b3c4d', token = TOKEN, releaseState = 'revoked', releaseFails = false } = {}) {
  const calls = []
  const run = (bin, args, options = {}) => {
    calls.push({ bin, args, env: options.env ?? {} })
    if (args[1] === 'create') return ok(JSON.stringify({ token, namespace: { id, state: 'active', ttl: '30m0s' } }, null, 2))
    if (args[1] === 'release') {
      if (releaseFails) return failed('Error: dial unix: connect: no such file or directory')
      return ok(JSON.stringify({ namespace: { id, state: releaseState } }, null, 2))
    }
    throw new Error(`unexpected plumb ${args.join(' ')}`)
  }
  return { calls, run }
}

test('ledger.create asks for a TTL, an owner and JSON, and returns the id and token', () => {
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: '/opt/plumb', run: plumb.run, ownerPid: 4321 })
  assert.deepEqual(ledger.create(), { id: 'ns-1a2b3c4d', token: TOKEN })
  assert.deepEqual(plumb.calls[0].args, ['namespace', 'create', '--ttl', '30m', '--owner-pid', '4321', '--json'])
  assert.deepEqual(ledger.outstanding(), ['ns-1a2b3c4d'])
})

test('ledger.create names this process as the owner by default', () => {
  const plumb = fakePlumb()
  createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run }).create()
  assert.equal(plumb.calls[0].args[plumb.calls[0].args.indexOf('--owner-pid') + 1], String(process.pid))
})

test('ledger.create: a failed or malformed answer throws, and holds nothing it cannot release', () => {
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: () => failed('Error: the daemon does not support namespaces') })
  assert.throws(() => ledger.create(), /plumb namespace create failed/)
  assert.deepEqual(ledger.outstanding(), [])
  const garbage = createNamespaceLedger({ plumbBin: 'plumb', run: () => ok('created!') })
  assert.throws(() => garbage.create(), /plumb namespace create failed/)
  assert.deepEqual(garbage.outstanding(), [])
})

test('ledger.create: an id that is not a namespace id is refused, but its token is still released', () => {
  for (const id of ['', 'default', 'ns-', 'ns-a b', 5]) {
    const plumb = fakePlumb({ id })
    const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
    assert.throws(() => ledger.create(), /did not return a token and a namespace id/, `id ${JSON.stringify(id)}`)
    assert.equal(ledger.outstanding().length, 1, 'the token that came back is still held')
    // Its release cannot match a bad id against the reply, but it is attempted.
    ledger.releaseAll()
    assert.ok(plumb.calls.some((call) => call.args[1] === 'release'), 'released')
  }
})

test('ledger.create: a reply with no namespace at all is refused too', () => {
  const run = (bin, args) => (args[1] === 'create' ? ok(JSON.stringify({ token: TOKEN })) : ok(JSON.stringify({ namespace: { state: 'revoked' } })))
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run })
  assert.throws(() => ledger.create(), /did not return a token and a namespace id/)
  assert.equal(ledger.outstanding().length, 1, 'the token is still held, to be released')
  assert.deepEqual(ledger.releaseAll().problems, [])
  assert.deepEqual(ledger.outstanding(), [])
})

test('ledger.create: no token means nothing to hold', () => {
  const plumb = fakePlumb({ token: '' })
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  assert.throws(() => ledger.create(), /did not return a token/)
  assert.deepEqual(ledger.outstanding(), [])
})

test('ledger.release passes the token in the environment, never on a command line', () => {
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: '/opt/plumb', run: plumb.run })
  const { id } = ledger.create()
  assert.equal(ledger.release(id), null)
  const call = plumb.calls.find((c) => c.args[1] === 'release')
  assert.deepEqual(call.args, ['namespace', 'release', '--json'])
  assert.equal(call.env.PLUMB_NAMESPACE, TOKEN)
  for (const c of plumb.calls) assert.ok(!c.args.some((arg) => arg.includes('SECRET')), 'the secret is on no command line (ps shows it)')
  assert.deepEqual(ledger.outstanding(), [])
})

test('ledger.release is confirmed only by a revoked namespace of that id', () => {
  const stillActive = fakePlumb({ releaseState: 'active' })
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: stillActive.run })
  const { id } = ledger.create()
  assert.match(ledger.release(id), /not revoked/)
  assert.deepEqual(ledger.outstanding(), [id], 'an unconfirmed release stays outstanding, for the exit hook to try again')

  const wrongId = fakePlumb()
  const l2 = createNamespaceLedger({ plumbBin: 'plumb', run: (bin, args, options) => {
    const reply = wrongId.run(bin, args, options)
    return args[1] === 'release' ? ok(JSON.stringify({ namespace: { id: 'ns-ffffffff', state: 'revoked' } })) : reply
  } })
  const created = l2.create()
  assert.match(l2.release(created.id), /ns-ffffffff/)
  assert.deepEqual(l2.outstanding(), [created.id])
})

test('ledger.release: a command that fails is a problem naming the namespace, not the token', () => {
  const plumb = fakePlumb({ releaseFails: true })
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  const { id } = ledger.create()
  const problem = ledger.release(id)
  assert.match(problem, new RegExp(`could not release namespace ${id}`))
  assert.ok(!problem.includes(TOKEN))
  assert.deepEqual(ledger.outstanding(), [id])
})

test('ledger.release: a namespace this run did not create is not released', () => {
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  assert.match(ledger.release('ns-deadbeef'), /was not created by this run/)
  assert.equal(plumb.calls.length, 0)
})

test('ledger.releaseAll releases what is outstanding, once', () => {
  let n = 0
  const calls = []
  const run = (bin, args, options = {}) => {
    calls.push({ args, token: options.env?.PLUMB_NAMESPACE })
    if (args[1] === 'create') { n += 1; return ok(JSON.stringify({ token: `pns1-token${n}`, namespace: { id: `ns-0000000${n}`, state: 'active' } })) }
    return ok(JSON.stringify({ namespace: { id: `ns-0000000${options.env.PLUMB_NAMESPACE.slice(-1)}`, state: 'revoked' } }))
  }
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run })
  const a = ledger.create()
  const b = ledger.create()
  const c = ledger.create()
  assert.equal(ledger.release(b.id), null)
  const first = ledger.releaseAll()
  assert.deepEqual(first.released.sort(), [a.id, c.id].sort())
  assert.deepEqual(first.problems, [])
  const releases = calls.filter((call) => call.args[1] === 'release')
  assert.deepEqual(releases.map((call) => call.token).sort(), ['pns1-token1', 'pns1-token2', 'pns1-token3'], 'each token once')
  assert.deepEqual(ledger.releaseAll(), { released: [], problems: [] })
  assert.equal(calls.filter((call) => call.args[1] === 'release').length, 3, 'nothing is released twice')
  assert.deepEqual(ledger.created().sort(), [a.id, b.id, c.id].sort())
})

test('ledger.releaseAll reports what it could not release and keeps it outstanding', () => {
  const plumb = fakePlumb({ releaseFails: true })
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  const { id } = ledger.create()
  const result = ledger.releaseAll()
  assert.deepEqual(result.released, [])
  assert.equal(result.problems.length, 1)
  assert.deepEqual(ledger.outstanding(), [id])
})

// -- release on exit ------------------------------------------------------------------------------

test('installExitRelease: the exit of the process releases every namespace still held', () => {
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  const { id } = ledger.create()
  const proc = new EventEmitter()
  const written = []
  installExitRelease(ledger, { proc, write: (line) => written.push(line) })
  assert.equal(proc.listenerCount('exit'), 1)
  proc.emit('exit', 0)
  assert.deepEqual(ledger.outstanding(), [])
  assert.deepEqual(written, [`e2e: exit: released namespace ${id}\n`])
})

test('installExitRelease: a run that released everything says nothing and runs nothing', () => {
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  const { id } = ledger.create()
  ledger.release(id)
  const before = plumb.calls.length
  const proc = new EventEmitter()
  const written = []
  installExitRelease(ledger, { proc, write: (line) => written.push(line) })
  proc.emit('exit', 0)
  assert.equal(plumb.calls.length, before)
  assert.deepEqual(written, [])
})

test('installExitRelease: a release that fails is reported on the way out', () => {
  const plumb = fakePlumb({ releaseFails: true })
  const ledger = createNamespaceLedger({ plumbBin: 'plumb', run: plumb.run })
  const { id } = ledger.create()
  const proc = new EventEmitter()
  const written = []
  installExitRelease(ledger, { proc, write: (line) => written.push(line) })
  proc.emit('exit', 1)
  assert.equal(written.length, 1)
  assert.match(written[0], new RegExp(`could not release namespace ${id}`))
})

test('installExitRelease: it is the real process by default, and a real exit releases', () => {
  // The control for the injected `proc`: a child that creates a namespace through
  // a stub plumb and then simply exits must release it from the exit hook.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-release-'))
  try {
    const log = path.join(dir, 'calls.log')
    const stub = path.join(dir, 'plumb')
    fs.writeFileSync(stub, `#!/bin/sh
echo "$@ ns=$PLUMB_NAMESPACE" >> '${log}'
case "$2" in
  create) echo '{"token":"pns1-childtoken","namespace":{"id":"ns-c0ffee01","state":"active"}}' ;;
  release) echo '{"namespace":{"id":"ns-c0ffee01","state":"revoked"}}' ;;
esac
`, { mode: 0o755 })
    const script = `
      import { createNamespaceLedger, installExitRelease } from ${JSON.stringify(new URL('./namespace-mode.mjs', import.meta.url).href)}
      const ledger = createNamespaceLedger({ plumbBin: ${JSON.stringify(stub)} })
      installExitRelease(ledger)
      ledger.create()
      process.exit(3)
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(child.status, 3, child.stderr)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 2, calls.join(' | '))
    assert.match(calls[0], /^namespace create /)
    assert.match(calls[1], /^namespace release --json ns=pns1-childtoken$/)
    assert.match(child.stderr, /released namespace ns-c0ffee01/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// -- the scenario's serves -----------------------------------------------------------------------------

test('namespaceWrapperScript: the token and the exec, and nothing that moves a daemon', () => {
  const script = namespaceWrapperScript({ plumbBin: '/opt/plumb/plumb', token: TOKEN })
  assert.match(script, /^#!\/bin\/sh\n/)
  assert.match(script, /^PLUMB_NAMESPACE='pns1-SECRETSECRETSECRET'$/m)
  assert.match(script, /^export PLUMB_NAMESPACE$/m)
  assert.match(script, /^exec '\/opt\/plumb\/plumb' "\$@"$/m)
  // The isolated-daemon wrapper's lines: any of them here would put the scenario
  // on a daemon of its own, which is the thing this isolation replaces.
  for (const forbidden of ['HOME=', 'XDG_', 'TSM_ORIG', 'unset', 'PLUMB_ACCOUNT_AUTHORITY']) {
    assert.ok(!script.includes(forbidden), `the wrapper must not touch ${forbidden}`)
  }
})

test('namespaceWrapperScript quotes what it is given', () => {
  const script = namespaceWrapperScript({ plumbBin: "/opt/it's here/plumb", token: "pns1-a'b$(touch x)" })
  assert.ok(script.includes(`exec '/opt/it'\\''s here/plumb' "$@"`))
  assert.ok(script.includes(`PLUMB_NAMESPACE='pns1-a'\\''b$(touch x)'`))
})

test('the wrapper, run: it hands its arguments to plumb with the token and an untouched environment', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fakeBin = path.join(dir, 'plumb it')
  fs.writeFileSync(fakeBin, '#!/bin/sh\nprintf "args=%s|ns=%s|home=%s|xdg=%s\\n" "$*" "$PLUMB_NAMESPACE" "$HOME" "${XDG_DATA_HOME-unset}"\n', { mode: 0o755 })
  const wrapper = writeNamespaceWrapper({ root: dir, plumbBin: fakeBin, token: TOKEN })
  const env = { ...process.env, HOME: '/the/real/home', PLUMB_NAMESPACE: 'pns1-ambient' }
  delete env.XDG_DATA_HOME
  const run = spawnSync(wrapper, ['hooks', 'run-claude'], { encoding: 'utf8', env })
  assert.equal(run.stdout.trim(), `args=hooks run-claude|ns=${TOKEN}|home=/the/real/home|xdg=unset`, run.stderr)
})

test('writeNamespaceWrapper: it holds a secret, so only its owner may read it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const wrapper = writeNamespaceWrapper({ root: dir, plumbBin: '/opt/plumb', token: TOKEN })
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o700)
  assert.equal(path.dirname(wrapper), dir)
})

// -- where the shared daemon keeps its files --------------------------------------------------------------

// `plumb service show`, as plumb prints it (TOML literal strings, after a banner).
const SERVICE_SHOW = `
/root/.local/share/plumb/service.toml

# plumb service launch profile.
#
# Written by \`plumb service install\`.
data = '/not/in/the/dirs/table'

executable = '/opt/plumb/plumb'
path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

[dirs]
config = '/root/.config/plumb'
data = '/root/.local/share/plumb'
state = '/root/.local/state/plumb'
log = '/root/.local/state/plumb'
cache = '/root/.cache/plumb'

[xdg]

[service]
env_seeded = true

[service.env]
ALL_PROXY = { inherit = true }
`

test('parseServiceDirs: the [dirs] table and only that', () => {
  assert.deepEqual(parseServiceDirs(SERVICE_SHOW), {
    config: '/root/.config/plumb', data: '/root/.local/share/plumb', state: '/root/.local/state/plumb',
    log: '/root/.local/state/plumb', cache: '/root/.cache/plumb',
  })
  assert.deepEqual(parseServiceDirs('data = "/not/in/a/table"'), {})
  assert.deepEqual(parseServiceDirs(''), {})
})

test('parseServiceDirs: a hand-edited profile may use basic strings, with escapes', () => {
  assert.equal(parseServiceDirs('[dirs]\ndata = "/a \\"b\\"/c\\\\d"\n').data, '/a "b"/c\\d')
  assert.equal(parseServiceDirs("[dirs]\ndata = '/lit\\eral'\n").data, '/lit\\eral', 'a literal string has no escapes')
})

test('resolveDaemonFiles: the session directory and the log, from what plumb says', () => {
  const run = (bin, args) => { assert.deepEqual(args, ['service', 'show']); return ok(SERVICE_SHOW) }
  assert.deepEqual(resolveDaemonFiles('plumb', { run }), {
    sessionsDir: '/root/.local/share/plumb/sessions',
    daemonLog: '/root/.local/state/plumb/daemon.log',
  })
})

test('resolveDaemonFiles: a profile it cannot read, or one with no usable directory, is an error', () => {
  assert.throws(() => resolveDaemonFiles('plumb', { run: () => failed('Error: no plumb service profile') }), /`plumb service show` failed/)
  assert.throws(() => resolveDaemonFiles('plumb', { run: () => ok('[dirs]\nlog = "/l"\n') }), /no absolute data directory/)
  assert.throws(() => resolveDaemonFiles('plumb', { run: () => ok('[dirs]\ndata = "relative/dir"\nlog = "/l"\n') }), /no absolute data directory/)
  assert.throws(() => resolveDaemonFiles('plumb', { run: () => ok('[dirs]\ndata = "/d"\n') }), /no absolute log directory/)
})

// -- the scenario's session source --------------------------------------------------------------------------

function writeSession(dir, id, fields) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, pid: 7, started_at: '2026-10-15T20:00:10Z', ended_at: '0001-01-01T00:00:00Z', client_name: 'dsh-plumb-identity', ...fields,
  }))
}

test('namespaceSource: a scenario sees its namespace\'s records and lines, and nothing of its neighbours', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sessionsDir = path.join(dir, 'sessions')
  fs.mkdirSync(sessionsDir)
  writeSession(sessionsDir, 'mine-1', { namespace: 'ns-aaaa1111' })
  writeSession(sessionsDir, 'mine-2', { namespace: 'ns-aaaa1111', client_name: 'dsh-mcp-client' })
  writeSession(sessionsDir, 'earlier-scenario', { namespace: 'ns-bbbb2222', started_at: '2026-10-15T19:50:00Z' })
  writeSession(sessionsDir, 'default-leak', { client_name: 'dsh-mcp-client' })
  writeSession(sessionsDir, 'default-owner', { client_name: 'claude-code' })
  const daemonLog = path.join(dir, 'daemon.log')
  const source = namespaceSource({ namespaceId: 'ns-aaaa1111', sessionsDir, daemonLog, startedAtMs: Date.parse('2026-10-15T20:00:00Z') })

  assert.deepEqual(source.records().map((r) => r.id).sort(), ['mine-1', 'mine-2'])
  assert.equal(source.daemonLog(), '', 'no log yet')
  fs.writeFileSync(daemonLog, [
    'level=WARN msg="daemon: shared connection detected" session_id=earlier-scenario',
    'level=INFO msg="fine" session_id=mine-1',
    'level=WARN msg="daemon: shared connection detected" session_id=default-leak',
    'level=INFO msg="no session"',
  ].join('\n'))
  assert.equal(source.daemonLog(), 'level=INFO msg="fine" session_id=mine-1', 'an earlier scenario\'s warning is not this scenario\'s')
  assert.deepEqual(source.strays().map((r) => r.id), ['default-leak'], 'only the e2e\'s own clients, outside the namespace, since it began')
})

test('namespaceSource: a log that cannot be read is an error, not an empty log', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'daemon.log')) // a directory where the log should be
  const source = namespaceSource({ namespaceId: 'ns-aaaa1111', sessionsDir: path.join(dir, 'sessions'), daemonLog: path.join(dir, 'daemon.log'), startedAtMs: 0 })
  assert.throws(() => source.daemonLog(), /cannot read the daemon log/)
})

test('namespaceSource: without a namespace id it will not read, rather than read the default namespace', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'sessions'))
  writeSession(path.join(dir, 'sessions'), 'default', {})
  const source = namespaceSource({ namespaceId: '', sessionsDir: path.join(dir, 'sessions'), daemonLog: path.join(dir, 'daemon.log'), startedAtMs: 0 })
  assert.throws(() => source.records(), /namespace id is required/)
})

// -- choosing the isolation for a run ---------------------------------------------------------------------

/** resolveIsolation's collaborators, recording which of them a branch touched. */
function spies({ probe = { ok: true, namespaces: [{ id: 'ns-1' }] } } = {}) {
  const touched = []
  return {
    touched,
    options: {
      probe: (bin) => { touched.push(['probe', bin]); return probe },
      findFiles: (bin) => { touched.push(['findFiles', bin]); return { sessionsDir: '/s', daemonLog: '/l' } },
      makeLedger: (options) => { touched.push(['makeLedger', options.plumbBin]); return { marker: 'ledger' } },
      installExit: (ledger) => { touched.push(['installExit', ledger.marker]) },
    },
  }
}

test('resolveIsolation: namespace by default, after the plumb in use passes the probe', () => {
  const spy = spies()
  const isolation = resolveIsolation('/opt/plumb', { env: {}, ...spy.options })
  assert.equal(isolation.mode, 'namespace')
  assert.deepEqual(isolation.files, { sessionsDir: '/s', daemonLog: '/l' })
  assert.deepEqual(isolation.ledger, { marker: 'ledger' })
  assert.match(isolation.describe, /^namespace \(one daemon, a namespace per scenario; 1 already listed\)$/)
  assert.deepEqual(spy.touched.map(([what]) => what), ['probe', 'findFiles', 'makeLedger', 'installExit'], 'probed first; the exit hook is on the ledger')
  assert.deepEqual(spy.touched[3], ['installExit', 'ledger'])
})

test('resolveIsolation: a plumb that cannot do namespaces is refused, never answered with a daemon per scenario', () => {
  for (const kind of ['binary', 'daemon-old', 'daemon-unreachable']) {
    for (const env of [{}, { E2E_ISOLATION: 'namespace' }]) {
      const spy = spies({ probe: { ok: false, kind, detail: `why ${kind}` } })
      assert.throws(
        () => resolveIsolation('/opt/plumb', { env, ...spy.options }),
        (error) => error instanceof NamespaceUnavailable && error.message.includes(`why ${kind}`) && error.message.includes('Refusing to fall back'),
        `${kind} ${JSON.stringify(env)}`,
      )
      assert.deepEqual(spy.touched.map(([what]) => what), ['probe'], 'a refused run finds no files, makes no ledger and installs no exit hook')
    }
  }
})

test('resolveIsolation: the older isolation is only what E2E_ISOLATION=daemon names, and it probes nothing', () => {
  const spy = spies({ probe: { ok: false, kind: 'binary', detail: 'no namespaces here' } })
  const isolation = resolveIsolation('/opt/plumb', { env: { E2E_ISOLATION: 'daemon' }, ...spy.options })
  assert.equal(isolation.mode, 'daemon')
  assert.equal(isolation.ledger, null)
  assert.equal(isolation.files, null)
  assert.deepEqual(spy.touched, [], 'daemon isolation uses no namespaces, so it asks the plumb nothing about them')
})

test('resolveIsolation: an unrecognised isolation fails before any probe', () => {
  const spy = spies()
  assert.throws(() => resolveIsolation('/opt/plumb', { env: { E2E_ISOLATION: 'isolated' }, ...spy.options }), /is not an isolation/)
  assert.deepEqual(spy.touched, [])
})

test('resolveIsolation: files it cannot find are an error, and nothing is made or hooked before it', () => {
  const spy = spies()
  spy.options.findFiles = () => { throw new Error('plumb service show failed') }
  assert.throws(() => resolveIsolation('/opt/plumb', { env: {}, ...spy.options }), /plumb service show failed/)
  assert.deepEqual(spy.touched.map(([what]) => what), ['probe'])
})

// -- one scenario in a namespace ----------------------------------------------------------------------------

function scenarioFixture(t, { releaseFails = false, now = () => Date.parse('2026-10-15T20:00:00Z') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-env-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sessionsDir = path.join(dir, 'sessions')
  fs.mkdirSync(sessionsDir)
  const root = path.join(dir, 'root')
  fs.mkdirSync(root)
  const plumb = fakePlumb({ releaseFails })
  const ledger = createNamespaceLedger({ plumbBin: '/opt/plumb', run: plumb.run })
  const files = { sessionsDir, daemonLog: path.join(dir, 'daemon.log') }
  const environment = createNamespaceEnvironment({ ledger, files, root, plumbBin: '/opt/plumb', now })
  return { dir, sessionsDir, root, plumb, ledger, files, environment }
}

test('createNamespaceEnvironment: a namespace, and a wrapper that puts every plumb process of the scenario in it', (t) => {
  const { environment, root, ledger } = scenarioFixture(t)
  assert.equal(environment.namespaceId, 'ns-1a2b3c4d')
  assert.equal(path.dirname(environment.plumbSh), root)
  assert.match(fs.readFileSync(environment.plumbSh, 'utf8'), new RegExp(`^PLUMB_NAMESPACE='${TOKEN}'$`, 'm'))
  assert.equal(fs.statSync(environment.plumbSh).mode & 0o777, 0o700)
  assert.deepEqual(ledger.outstanding(), ['ns-1a2b3c4d'])
})

test('createNamespaceEnvironment: it reads the namespace\'s records, and refuses to call a scenario with none a pass', (t) => {
  const { environment, sessionsDir } = scenarioFixture(t)
  assert.match(environment.beforeExpect(), /namespace ns-1a2b3c4d has no session record/, 'an empty directory')
  // Another namespace\'s and the default namespace\'s records are not this scenario\'s.
  writeSession(sessionsDir, 'elsewhere', { namespace: 'ns-ffffffff' })
  writeSession(sessionsDir, 'default', {})
  assert.match(environment.beforeExpect(), /has no session record/, 'only other namespaces\' records')
  writeSession(sessionsDir, 'mine', { namespace: 'ns-1a2b3c4d' })
  assert.equal(environment.beforeExpect(), null)
  assert.deepEqual(environment.source.records().map((r) => r.id), ['mine'])
})

test('createNamespaceEnvironment: a session of the scenario\'s own clients outside its namespace is a failure', (t) => {
  const { environment, sessionsDir } = scenarioFixture(t)
  writeSession(sessionsDir, 'mine', { namespace: 'ns-1a2b3c4d' })
  assert.equal(environment.afterExpect(), null)
  writeSession(sessionsDir, 'leak', { client_name: 'dsh-plumb-identity', started_at: '2026-10-15T20:00:05Z' })
  const problem = environment.afterExpect()
  assert.match(problem, /1 session\(s\) of the scenario's processes are outside namespace ns-1a2b3c4d: leak \(dsh-plumb-identity, namespace default\)/)
})

test('createNamespaceEnvironment: a session from before the scenario began is not its leak', (t) => {
  const { environment, sessionsDir } = scenarioFixture(t)
  writeSession(sessionsDir, 'older', { client_name: 'dsh-plumb-identity', started_at: '2026-10-15T19:00:00Z' })
  assert.equal(environment.afterExpect(), null)
})

test('createNamespaceEnvironment: teardown releases the namespace and says so', async (t) => {
  const { environment, ledger, plumb } = scenarioFixture(t)
  assert.deepEqual(await environment.teardown(), { notes: ['released namespace ns-1a2b3c4d'], problems: [] })
  assert.deepEqual(ledger.outstanding(), [])
  assert.equal(plumb.calls.filter((c) => c.args[1] === 'release').length, 1)
  // The signal handler and the scenario's finally may both call it.
  assert.deepEqual(await environment.teardown(), { notes: ['released namespace ns-1a2b3c4d'], problems: [] })
  assert.equal(plumb.calls.filter((c) => c.args[1] === 'release').length, 1, 'plumb is asked once')
})

test('createNamespaceEnvironment: a release that fails is a teardown problem, and the namespace stays outstanding', async (t) => {
  const { environment, ledger } = scenarioFixture(t, { releaseFails: true })
  const result = await environment.teardown()
  assert.deepEqual(result.notes, [])
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /could not release namespace ns-1a2b3c4d/)
  assert.deepEqual(ledger.outstanding(), ['ns-1a2b3c4d'])
})

test('createNamespaceEnvironment: a scenario that cannot be set up releases the namespace it just made', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-env-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plumb = fakePlumb()
  const ledger = createNamespaceLedger({ plumbBin: '/opt/plumb', run: plumb.run })
  assert.throws(
    () => createNamespaceEnvironment({ ledger, files: { sessionsDir: dir, daemonLog: path.join(dir, 'l') }, root: path.join(dir, 'no', 'such', 'root'), plumbBin: '/opt/plumb' }),
    /ENOENT/,
  )
  assert.deepEqual(ledger.outstanding(), [], 'nothing is left active')
  assert.equal(plumb.calls.filter((c) => c.args[1] === 'release').length, 1)
})

test('createNamespaceEnvironment: when the scenario cannot be set up and the release fails too, both are said', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-env-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plumb = fakePlumb({ releaseFails: true })
  const ledger = createNamespaceLedger({ plumbBin: '/opt/plumb', run: plumb.run })
  assert.throws(
    () => createNamespaceEnvironment({ ledger, files: { sessionsDir: dir, daemonLog: path.join(dir, 'l') }, root: path.join(dir, 'missing'), plumbBin: '/opt/plumb' }),
    /ENOENT.*\(and could not release namespace ns-1a2b3c4d/s,
  )
  assert.deepEqual(ledger.outstanding(), ['ns-1a2b3c4d'], 'still outstanding, for the exit hook')
})

test('createNamespaceEnvironment: the daemon log it reads is the scenario\'s own lines', (t) => {
  const { environment, sessionsDir, files } = scenarioFixture(t)
  writeSession(sessionsDir, 'mine', { namespace: 'ns-1a2b3c4d' })
  fs.writeFileSync(files.daemonLog, [
    'level=WARN msg="daemon: shared connection detected" session_id=somebody-else',
    'level=INFO msg="ok" session_id=mine',
  ].join('\n'))
  assert.equal(environment.source.daemonLog(), 'level=INFO msg="ok" session_id=mine')
})
