// The e2e's host refusal (test/separate-env.mjs), PLAN-526.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakePlumb } from './fake-plumb.mjs'
import { CONTAINER_MARKERS, readableFile, separateEnvironment } from './separate-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'separate-env-vectors.json'), 'utf8'))

for (const c of VECTORS.cases) {
  test(`separateEnvironment: ${c.name}`, () => {
    const readable = (p) => c.readable.includes(p)
    assert.equal(separateEnvironment({ env: c.env, platform: c.platform, readable }), c.expect)
  })
}

test('the markers are exactly the two the vectors use', () => {
  assert.deepEqual(CONTAINER_MARKERS, ['/.dockerenv', '/run/.containerenv'])
})

test('readableFile: a readable regular file only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepenv-'))
  t.after(() => {
    try { fs.chmodSync(path.join(dir, 'locked'), 0o600) } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'marker')
  fs.writeFileSync(file, '')
  assert.equal(readableFile(file), true, 'an empty regular file (Docker writes /.dockerenv empty)')
  assert.equal(readableFile(dir), false, 'a directory')
  assert.equal(readableFile(path.join(dir, 'missing')), false, 'a missing path')
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling'))
  assert.equal(readableFile(path.join(dir, 'dangling')), false, 'a dangling symlink')
  const locked = path.join(dir, 'locked')
  fs.writeFileSync(locked, '')
  fs.chmodSync(locked, 0o000)
  if (process.getuid?.() !== 0) assert.equal(readableFile(locked), false, 'a file this process cannot read')
})

// Every way of asking the e2e for anything must stop at the guard on a host: each
// isolation, a namespace token in the environment (not evidence of anything), and
// the flags that print and exit, which are not an escape hatch.
const HOST_CASES = [
  { name: 'default isolation', env: {}, args: ['--mode', 'tool-call'] },
  { name: 'E2E_ISOLATION=namespace', env: { E2E_ISOLATION: 'namespace' }, args: ['--mode', 'tool-call'] },
  { name: 'E2E_ISOLATION=daemon', env: { E2E_ISOLATION: 'daemon' }, args: ['--mode', 'tool-call'] },
  { name: 'namespace isolation with a namespace token in the environment', env: { E2E_ISOLATION: 'namespace', PLUMB_NAMESPACE: 'pns1-0123456789abcdef' }, args: ['--mode', 'tool-call'] },
  { name: '--isolation', env: { E2E_ISOLATION: 'namespace' }, args: ['--isolation'] },
  { name: '--list', env: {}, args: ['--list'] },
]

for (const c of HOST_CASES) {
  test(`the e2e refuses on a host before it creates anything: ${c.name}`, (t) => {
    const env = { ...process.env }
    delete env.GITHUB_ACTIONS
    delete env.PLUMB_SEPARATE_ENV
    delete env.E2E_ISOLATION
    delete env.PLUMB_NAMESPACE
    // The owner's opt-in is not this test's to inherit: an exported one would send the
    // child past the early refusal, to a plumb of its own choosing.
    delete env.DSH_E2E_HOST_DAEMON
    // Only a container marker can still make the child's environment separate.
    if (separateEnvironment({ env }) !== null) {
      t.skip('this process runs in a container')
      return
    }
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sepenv-dsh-'))
    t.after(() => fs.rmSync(dshHome, { recursive: true, force: true }))
    const before = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-')))
    // Nothing a run past the guard needs can resolve: no dsh (DSH_BIN names a
    // launcher that does not exist), so it would throw "DSH_BIN=/nonexistent/dsh does not exist" with exit 1 before
    // any scenario, and the only plumb is a fake script (fake-plumb.mjs), never the
    // sibling ../plumb/plumb the e2e falls back to when PLUMB_BIN does not exist.
    // A broken guard therefore fails this test, and shows in the fake's log,
    // without starting a daemon or creating a namespace.
    const fake = fakePlumb(dshHome, { listings: [''] })
    Object.assign(env, c.env)
    env.DSH_BIN = '/nonexistent/dsh'
    env.DSH_HOME = dshHome
    env.PLUMB_BIN = fake.bin
    env.PATH = '/nonexistent'
    const run = spawnSync(process.execPath, [path.join(HERE, 'e2e-mock-provider.mjs'), ...c.args], { env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(run.status, 2, `exit ${run.status}\n${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, /refusing to run here/)
    assert.match(run.stderr, /not to start, stop or write namespaces into/)
    assert.doesNotMatch(run.stdout, /e2e: (harness|isolation)/)
    assert.equal(run.stdout.trim(), '', 'a refused run prints nothing, not even a scenario list or an isolation')
    assert.deepEqual(fake.calls(), [], 'plumb was never run')
    const after = fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-') && !before.has(n))
    assert.deepEqual(after, [], 'no scenario root was created')
  })
}
