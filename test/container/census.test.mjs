// The container census (test/container/census.mjs), against a fake /proc.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { census, plumbDaemons } from './census.mjs'

const CENSUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'census.mjs')

// entries: pid -> argv, or pid -> { argv, ppid, comm }. The parent defaults to 1.
function fakeProc(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [pid, entry] of Object.entries(entries)) {
    const { argv, ppid = 1, comm = 'plumb', flags = 4194304 } = Array.isArray(entry) ? { argv: entry } : entry
    fs.mkdirSync(path.join(root, pid))
    fs.writeFileSync(path.join(root, pid, 'cmdline'), argv.map((a) => `${a}\0`).join(''))
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 ${flags} 0 0`)
  }
  return root
}

test('counts only processes whose own argv is plumb daemon', (t) => {
  const proc = fakeProc(t, {
    10: ['/opt/plumb/plumb', 'daemon'],
    11: ['plumb', 'daemon', '--log-level', 'debug'],
    20: ['/bin/sh', '/tmp/dsh-identity-e2e-x/plumb-isolated.sh', 'serve'],
    21: ['/opt/plumb/plumb', 'serve'],
    22: ['node', '/opt/plumb/plumb', 'daemon'],
    23: ['/usr/bin/grep', 'plumb daemon'],
    24: ['/opt/x/notplumb', 'daemon'],
    25: ['/opt/plumb/plumb'],
    26: [], // a zombie: empty cmdline
    27: ['/opt/plumb/plumb', 'debug', 'daemons'],
    28: ['/opt/plumb/plumb', 'stop', 'daemon'],
  })
  fs.mkdirSync(path.join(proc, 'self'))
  assert.deepEqual(plumbDaemons(proc).map((d) => d.pid).sort((a, b) => a - b), [10, 11])
})

test('a process gone between listing and read is skipped', (t) => {
  const proc = fakeProc(t, { 10: ['/opt/plumb/plumb', 'daemon'], 11: ['/opt/plumb/plumb', 'daemon'] })
  for (const code of ['ENOENT', 'ESRCH']) {
    const read = (file) => {
      if (file.includes('/11/')) throw Object.assign(new Error(code), { code })
      return fs.readFileSync(file, 'utf8')
    }
    assert.deepEqual(plumbDaemons(proc, read).map((d) => d.pid), [10], code)
  }
})

test('any other read error fails the census instead of counting nothing', (t) => {
  const proc = fakeProc(t, { 10: ['/opt/plumb/plumb', 'daemon'] })
  for (const code of ['EACCES', 'EIO', 'EPERM', undefined]) {
    const read = () => { throw Object.assign(new Error(`boom ${code}`), { code }) }
    assert.throws(() => plumbDaemons(proc, read), /census: cannot read/, String(code))
  }
})

test('the CLI rejects a malformed rescan length', () => {
  for (const args of [['rescan'], ['rescan', 'soon'], ['watch'], ['nope', '1']]) {
    const run = spawnSync(process.execPath, [CENSUS, ...args], { encoding: 'utf8' })
    assert.equal(run.status, 64, `${args.join(' ')}: ${run.stderr}`)
  }
})

const EXECED = 4194304 // a typical flags value (PF_RANDOMIZE)
const FORKED = EXECED | 0x40 // the same, plus PF_FORKNOEXEC: forked, not yet exec'd

test('a forked, not-yet-exec\'d lookalike is reported as forked; an exec\'d plumb daemon counts whatever its parent', (t) => {
  const proc = fakeProc(t, {
    10: { argv: ['/opt/plumb/plumb', 'daemon'], ppid: 5 }, // started by a serve
    11: { argv: ['/opt/plumb/plumb', 'daemon'], ppid: 10, flags: FORKED }, // daemon 10 forking gopls
    12: { argv: ['/opt/plumb/plumb', 'daemon'], ppid: 6 }, // a lock loser another serve started
    13: { argv: ['/opt/plumb/plumb', 'daemon'], ppid: 10, flags: EXECED }, // a real daemon a daemon's child exec'd (run_task)
    14: { argv: ['/opt/plumb/plumb', 'daemon'], ppid: 10, flags: FORKED, comm: 'odd) name (x' },
  })
  const snap = census(proc)
  assert.deepEqual(snap.daemons.map((d) => d.pid).sort((a, b) => a - b), [10, 12, 13])
  assert.deepEqual(snap.forked.map((d) => d.pid).sort((a, b) => a - b), [11, 14])
  assert.deepEqual(plumbDaemons(proc).map((d) => d.pid).sort((a, b) => a - b), [10, 12, 13])
})

test('stat is read before cmdline, so an exec between the two cannot pair a stale argv with a cleared flag', (t) => {
  const proc = fakeProc(t, { 10: ['/opt/plumb/plumb', 'daemon'], 11: ['/bin/sh'] })
  const order = []
  const read = (file) => { order.push(file.split('/').slice(-2).join('/')); return fs.readFileSync(file, 'utf8') }
  census(proc, read)
  for (const pid of ['10', '11']) assert.ok(order.indexOf(`${pid}/stat`) < order.indexOf(`${pid}/cmdline`), order.join(' '))
})

test('an unreadable or unparsable stat fails the census', (t) => {
  const proc = fakeProc(t, { 10: ['/opt/plumb/plumb', 'daemon'] })
  const eacces = (file) => {
    if (file.endsWith('/stat')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return fs.readFileSync(file, 'utf8')
  }
  assert.throws(() => census(proc, eacces), /census: cannot read/)
  for (const bad of [
    '10 (plumb) S 1 10 10 0 -1 notanumber', // a non-numeric flags field
    '0 0 0 0 0 0 64 0 0', // no "pid (comm) " header: field 6 would read as PF_FORKNOEXEC
    '11 (plumb) S 1 10 10 0 -1 4194304 0 0', // the header names another pid
    '10 (plumb) S 1', // too few fields
  ]) {
    const garbled = (file) => (file.endsWith('/stat') ? bad : fs.readFileSync(file, 'utf8'))
    assert.throws(() => census(proc, garbled), /cannot parse/, bad)
  }
})
