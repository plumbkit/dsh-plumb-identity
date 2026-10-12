// The e2e teardown (test/isolated-daemon.mjs) against a fake daemon process,
// so no plumb daemon is started. PLAN-507: the first teardown trusted `ps` to
// pick its targets and called "nothing found" clean, so inside a sandbox that
// denies `ps` it left every daemon running and let the harness delete its root.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endProcessGroup, isAlive, stopIsolatedDaemon } from './isolated-daemon.mjs'

const FAKE_DAEMON = fileURLToPath(new URL('./fixtures/fake-daemon.mjs', import.meta.url))
const PS_DENIED = () => null
const PS_PLUMB = () => '/usr/local/bin/plumb daemon'
const PS_FOREIGN = () => '/usr/bin/some-other-process'
const FAST = { stopWaitMs: 2_000, observeMs: 500 }

/** A scratch plumbhome (shallow, for the Unix socket path limit) and its runtime dir. */
function scratchHome(t) {
  const root = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'iso-daemon-'))
  const plumbHome = path.join(root, 'plumbhome')
  const runtimeDir = path.join(plumbHome, 'Library', 'Caches', 'plumb')
  const started = []
  t.after(() => {
    // Kill whatever the case left behind, by the pidfile and the pids it started.
    for (const pid of started) killQuietly(pid)
    const pidFile = path.join(runtimeDir, 'plumb.pid')
    try { killQuietly(Number(fs.readFileSync(pidFile, 'utf8'))) } catch { /* no pidfile, or not a file */ }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { plumbHome, runtimeDir, started }
}

async function startFake({ runtimeDir, started }, mode) {
  const child = spawn(process.execPath, [FAKE_DAEMON, runtimeDir, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
  started.push(child.pid)
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', (code) => reject(new Error(`fake daemon exited early (${code})`)))
  })
  return child.pid
}

/** A live process that is not a daemon, named by a stale pidfile: a reused pid. */
function staleDaemonPidfile({ runtimeDir, started }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
  started.push(child.pid)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'plumb.pid'), String(child.pid))
  return child.pid
}

function killQuietly(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return // never a group or every process
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

test('ps denied (the sandbox case): the daemon is still found by its live socket and stopped', async (t) => {
  const home = scratchHome(t)
  const { plumbHome, runtimeDir } = home
  const pid = await startFake(home, 'graceful')
  const { stopped, problems } = await stopIsolatedDaemon(plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(problems, [])
  assert.deepEqual(stopped, [pid])
  assert.equal(isAlive(pid), false)
})

test('ps answering "plumb daemon": the daemon is stopped', async (t) => {
  const home = scratchHome(t)
  const { plumbHome, runtimeDir } = home
  const pid = await startFake(home, 'graceful')
  const { stopped, problems } = await stopIsolatedDaemon(plumbHome, { ...FAST, probeCommand: PS_PLUMB })
  assert.deepEqual(problems, [])
  assert.deepEqual(stopped, [pid])
})

test('a daemon that ignores SIGTERM is reported, not called clean', async (t) => {
  const home = scratchHome(t)
  const { plumbHome, runtimeDir } = home
  const pid = await startFake(home, 'stubborn')
  const { stopped, problems } = await stopIsolatedDaemon(plumbHome, { ...FAST, probeCommand: PS_PLUMB })
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes(`pid ${pid} survived SIGTERM`)), problems.join('\n'))
  assert.ok(problems.some((p) => p.includes('still listening')), problems.join('\n'))
})

test('a listening socket with no pidfile fails closed instead of reading as "nothing found"', async (t) => {
  const home = scratchHome(t)
  const { plumbHome, runtimeDir } = home
  await startFake(home, 'no-pidfile')
  const { stopped, problems } = await stopIsolatedDaemon(plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes(`still listening on ${path.join(runtimeDir, 'plumb.sock')}`)), problems.join('\n'))
})

test('a daemon respawned after the stop is caught by the watch', async (t) => {
  const home = scratchHome(t)
  const { plumbHome, runtimeDir } = home
  const pid = await startFake(home, 'respawn')
  const { stopped, problems } = await stopIsolatedDaemon(plumbHome, { ...FAST, probeCommand: PS_PLUMB })
  assert.deepEqual(stopped, [pid])
  assert.ok(problems.some((p) => p.includes('still listening')), problems.join('\n'))
  assert.ok(problems.some((p) => p.includes('names live pid')), problems.join('\n'))
})

test('a daemon respawned late in the watch is still caught (PLAN-526)', async (t) => {
  const home = scratchHome(t)
  const pid = await startFake(home, 'late-respawn')
  const started = Date.now()
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, observeMs: 4_000, probeCommand: PS_PLUMB })
  assert.deepEqual(stopped, [pid])
  assert.ok(problems.some((p) => p.includes('still listening')), problems.join('\n'))
  // The replacement binds 1.5 s after the stop: a single check at the old 500 ms settle would have missed it.
  assert.ok(Date.now() - started >= 1_400, 'the watch saw it only after the replacement bound')
})

test('a clean stop is watched for the whole window before it counts as clean', async (t) => {
  const home = scratchHome(t)
  await startFake(home, 'graceful')
  const started = Date.now()
  const { problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, observeMs: 1_500, probeCommand: PS_PLUMB })
  assert.deepEqual(problems, [])
  assert.ok(Date.now() - started >= 1_500, `returned after ${Date.now() - started} ms, before the 1500 ms watch ended`)
})

test('a directory under HOME that cannot be listed is a problem, not a clean HOME (PLAN-526)', { skip: process.getuid?.() === 0 && 'root lists any directory' }, async (t) => {
  const home = scratchHome(t)
  const hidden = path.join(home.plumbHome, 'Library')
  fs.mkdirSync(hidden, { recursive: true })
  fs.chmodSync(hidden, 0o000) // readdir now fails with EACCES
  let result
  try {
    result = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  } finally {
    fs.chmodSync(hidden, 0o700) // before scratchHome's cleanup removes the tree
  }
  const { stopped, problems } = result
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes(`could not list ${hidden}`)), problems.join('\n'))
})

test('a HOME that cannot be looked at is a problem; a missing one is clean', { skip: process.getuid?.() === 0 && 'root stats any path' }, async (t) => {
  const home = scratchHome(t)
  const parent = path.dirname(home.plumbHome)
  fs.mkdirSync(home.plumbHome, { recursive: true })
  fs.chmodSync(parent, 0o000) // stat of plumbhome now fails with EACCES
  let denied
  try {
    denied = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  } finally {
    fs.chmodSync(parent, 0o700)
  }
  assert.ok(denied.problems.some((p) => p.includes(`could not observe ${home.plumbHome}`)), denied.problems.join('\n'))
  const missing = await stopIsolatedDaemon(path.join(parent, 'never-created'), { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(missing, { stopped: [], problems: [] })
})

test('a socket file with no listener (a daemon that died without cleaning up) reads as stopped', async (t) => {
  const home = scratchHome(t)
  const pid = await startFake(home, 'no-pidfile')
  process.kill(pid, 'SIGKILL') // no handler runs, so plumb.sock stays behind
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(fs.existsSync(path.join(home.runtimeDir, 'plumb.sock')), true, 'the stale socket file must exist for this case')
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(stopped, [])
  assert.deepEqual(problems, [])
})

test('a socket that refuses with something other than "nobody here" counts as listening', { skip: process.getuid?.() === 0 && 'root bypasses the socket mode' }, async (t) => {
  const home = scratchHome(t)
  await startFake(home, 'no-pidfile')
  fs.chmodSync(path.join(home.runtimeDir, 'plumb.sock'), 0o000) // connect now fails with EACCES
  const { problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.ok(problems.some((p) => p.includes('still listening')), problems.join('\n'))
})

test('ps denied: a pidfile older than the listening socket is reported, never signalled', async (t) => {
  const home = scratchHome(t)
  const stale = staleDaemonPidfile(home)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(path.join(home.runtimeDir, 'plumb.pid'), old, old)
  await startFake(home, 'no-pidfile') // a live daemon whose socket is newer than that pidfile
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes(`pid ${stale}`) && p.includes('cannot be confirmed')), problems.join('\n'))
  assert.equal(isAlive(stale), true, 'a pid from a stale pidfile must not be signalled')
})

test('an unreadable pidfile is a problem, not an exception that skips teardown', async (t) => {
  const home = scratchHome(t)
  fs.mkdirSync(path.join(home.runtimeDir, 'plumb.pid'), { recursive: true }) // reads fail with EISDIR, even as root
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes('could not read') && p.includes('EISDIR')), problems.join('\n'))
})

test('ps denied and no listening socket: a live pid from a pidfile is reported, never signalled', async (t) => {
  const home = scratchHome(t)
  const pid = staleDaemonPidfile(home)
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_DENIED })
  assert.deepEqual(stopped, [])
  assert.ok(problems.some((p) => p.includes(`pid ${pid}`) && p.includes('cannot be confirmed')), problems.join('\n'))
  assert.equal(isAlive(pid), true, 'an unconfirmed pid must not be signalled')
})

test('ps naming another process: a stale pidfile is left alone and is not a problem', async (t) => {
  const home = scratchHome(t)
  const pid = staleDaemonPidfile(home)
  const { stopped, problems } = await stopIsolatedDaemon(home.plumbHome, { ...FAST, probeCommand: PS_FOREIGN })
  assert.deepEqual(stopped, [])
  assert.deepEqual(problems, [])
  assert.equal(isAlive(pid), true, 'a process ps names as foreign must not be signalled')
})

test('by default a stop is watched for 30 s before it counts as clean (PLAN-526)', async (t) => {
  const home = scratchHome(t)
  fs.mkdirSync(home.runtimeDir, { recursive: true }) // a HOME with nothing running in it
  let now = 0
  const clock = { now: () => now, sleep: async (ms) => { now += ms } }
  const { problems } = await stopIsolatedDaemon(home.plumbHome, { probeCommand: PS_DENIED, clock })
  assert.deepEqual(problems, [])
  assert.ok(now >= 30_000, `watched ${now} ms of fake time, want the 30 000 ms default`)
  assert.ok(now < 30_500, `watched ${now} ms, more than the default plus one step`)
})

test('no plumbhome at all: nothing to stop and nothing wrong', async () => {
  const { stopped, problems } = await stopIsolatedDaemon(path.join(os.tmpdir(), 'iso-daemon-absent', 'plumbhome'), FAST)
  assert.deepEqual(stopped, [])
  assert.deepEqual(problems, [])
})

/**
 * A dsh stand-in in its own process group: a leader that starts one more
 * process (the serve), then both idle. `stubborn` makes the serve ignore SIGTERM.
 */
async function startGroup(t, { stubborn = false, termMarker = '' } = {}) {
  const onTerm = stubborn
    ? "process.on('SIGTERM', () => {});"
    : `process.on('SIGTERM', () => { ${termMarker ? `require('node:fs').writeFileSync(${JSON.stringify(termMarker)}, 'SIGTERM');` : ''} process.exit(0) });`
  const serve = `${onTerm} console.log('ready'); setInterval(() => {}, 1e9)`
  const leader = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(serve)}], { stdio: ['ignore', 'pipe', 'ignore'] }); c.stdout.once('data', () => console.log(c.pid)); setInterval(() => {}, 1e9)`
  const child = spawn(process.execPath, ['-e', leader], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const servePid = Number(await new Promise((resolve) => child.stdout.once('data', resolve)))
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } })
  return { pgid: child.pid, servePid }
}

test('endProcessGroup ends dsh and the serve it started, not just dsh', async (t) => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-group-')), 'serve-term')
  t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }))
  const { pgid, servePid } = await startGroup(t, { termMarker: marker })
  assert.equal(await endProcessGroup(pgid, { waitMs: 2_000 }), null)
  assert.equal(isAlive(servePid), false, 'the serve must not outlive teardown: it would redial and respawn the daemon')
  // The graceful signal reached the serve itself, not only dsh (SIGKILL is the fallback).
  assert.equal(fs.existsSync(marker), true, 'the serve never saw SIGTERM')
})

test('endProcessGroup escalates to SIGKILL when a member ignores SIGTERM', async (t) => {
  const { pgid, servePid } = await startGroup(t, { stubborn: true })
  assert.equal(await endProcessGroup(pgid, { waitMs: 500 }), null)
  assert.equal(isAlive(servePid), false)
})

test('endProcessGroup on a group that is already gone is not a problem', async (t) => {
  const { pgid } = await startGroup(t)
  process.kill(-pgid, 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await endProcessGroup(pgid, { waitMs: 500 }), null)
})
