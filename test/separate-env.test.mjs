// The e2e's host refusal (test/separate-env.mjs), PLAN-526.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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

test('the e2e refuses on a host before it creates anything', (t) => {
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS
  delete env.PLUMB_SEPARATE_ENV
  // Only a container marker can still make the child's environment separate.
  if (separateEnvironment({ env }) !== null) {
    t.skip('this process runs in a container')
    return
  }
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sepenv-dsh-'))
  t.after(() => fs.rmSync(dshHome, { recursive: true, force: true }))
  const before = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-')))
  // Nothing a run past the guard needs can resolve: no dsh (DSH_BIN missing,
  // DSH_HOME empty), so it would throw "no dsh install found" with exit 1 before
  // any scenario, and no plumb on PATH. A broken guard therefore fails this test
  // without starting a daemon.
  env.DSH_BIN = '/nonexistent/dsh'
  env.DSH_HOME = dshHome
  env.PLUMB_BIN = '/nonexistent/plumb'
  env.PATH = '/nonexistent'
  const run = spawnSync(process.execPath, [path.join(HERE, 'e2e-mock-provider.mjs'), '--mode', 'tool-call'], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 2, `exit ${run.status}\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /refusing to run here/)
  assert.doesNotMatch(run.stdout, /e2e: harness/)
  const after = fs.readdirSync('/tmp').filter((n) => n.startsWith('dsh-identity-e2e-') && !before.has(n))
  assert.deepEqual(after, [], 'no scenario root was created')
})
