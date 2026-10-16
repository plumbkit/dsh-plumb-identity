// Where the e2e finds dsh (test/dsh-launcher.mjs), on real directory trees: the
// profile tree, the npx cache, and the case this was written for, a profile link
// left dangling into a cleaned npx directory beside the one dsh 0.2 runs from.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { findDshLauncher, nearestNodeModules } from './dsh-launcher.mjs'

const LAUNCHER = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')

function tree(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

/** A dsh install: `<nodeModules>/@deepseek-ai/dsh/lib/bin.js`. */
function install(nodeModules) {
  const bin = path.join(nodeModules, LAUNCHER)
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '')
  return bin
}

test('the profile tree, when it holds dsh, comes before the npx cache', (t) => {
  const home = tree(t)
  const profile = path.join(home, '.dsh', 'profiles', 'node_modules')
  const bin = install(profile)
  install(path.join(home, '.npm', '_npx', 'aaaa', 'node_modules'))
  assert.deepEqual(findDshLauncher({ env: {}, home }), { bin, hoisted: profile })
})

test('a profile link left dangling into a cleaned npx directory falls to the one dsh in the npx cache', (t) => {
  const home = tree(t)
  const profile = path.join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(path.join(home, '.npm', '_npx', 'cleaned', 'node_modules', '@deepseek-ai', 'dsh'), path.join(profile, 'dsh'))
  const npx = path.join(home, '.npm', '_npx', 'c8633a242642d858', 'node_modules')
  const bin = install(npx)
  // An npx directory holding something else is not a dsh.
  fs.mkdirSync(path.join(home, '.npm', '_npx', 'other', 'node_modules', 'left-pad'), { recursive: true })
  assert.deepEqual(findDshLauncher({ env: {}, home }), { bin, hoisted: npx })
})

test('npm_config_cache moves where it looks in the npx cache', (t) => {
  const home = tree(t)
  install(path.join(home, '.npm', '_npx', 'aaaa', 'node_modules'))
  const cache = path.join(home, 'cache')
  const npx = path.join(cache, '_npx', 'bbbb', 'node_modules')
  const bin = install(npx)
  assert.deepEqual(findDshLauncher({ env: { npm_config_cache: cache }, home }), { bin, hoisted: npx })
})

test('DSH_HOME moves where it looks for the profile tree', (t) => {
  const home = tree(t)
  install(path.join(home, '.dsh', 'profiles', 'node_modules'))
  const profile = path.join(home, 'custom-dsh-home', 'profiles', 'node_modules')
  const bin = install(profile)
  assert.deepEqual(findDshLauncher({ env: { DSH_HOME: path.join(home, 'custom-dsh-home') }, home }), { bin, hoisted: profile })
})

test('several dsh installs in the npx cache are not guessed between', (t) => {
  const home = tree(t)
  const a = install(path.join(home, '.npm', '_npx', 'aaaa', 'node_modules'))
  const b = install(path.join(home, '.npm', '_npx', 'bbbb', 'node_modules'))
  assert.throws(() => findDshLauncher({ env: {}, home }), (error) => {
    assert.match(error.message, /2 dsh installs in the npx cache/)
    assert.ok(error.message.includes(a) && error.message.includes(b), error.message)
    return true
  })
})

test('with nothing installed it names both places it looked', (t) => {
  const home = tree(t)
  assert.throws(() => findDshLauncher({ env: {}, home }), (error) => {
    assert.match(error.message, /no dsh install found/)
    assert.ok(error.message.includes(path.join(home, '.dsh', 'profiles', 'node_modules')), error.message)
    assert.ok(error.message.includes(path.join(home, '.npm', '_npx')), error.message)
    return true
  })
})

test('DSH_BIN is the answer when set: inside a node_modules tree it is used as named', (t) => {
  const home = tree(t)
  install(path.join(home, '.dsh', 'profiles', 'node_modules'))
  const hoisted = path.join(home, 'elsewhere', 'node_modules')
  const bin = path.join(hoisted, 'fake-dsh', 'dsh')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '')
  assert.deepEqual(findDshLauncher({ env: { DSH_BIN: bin }, home }), { bin, hoisted })
})

test('a DSH_BIN that does not exist is an error, not a reason to look elsewhere', (t) => {
  const home = tree(t)
  install(path.join(home, '.dsh', 'profiles', 'node_modules'))
  install(path.join(home, '.npm', '_npx', 'aaaa', 'node_modules'))
  assert.throws(() => findDshLauncher({ env: { DSH_BIN: '/nonexistent/dsh' }, home }), /DSH_BIN=\/nonexistent\/dsh does not exist/)
})

test('a DSH_BIN outside any node_modules tree (a PATH symlink) is refused, saying what to name', (t) => {
  const home = tree(t)
  const bin = path.join(home, 'bin', 'dsh')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '')
  assert.throws(() => findDshLauncher({ env: { DSH_BIN: bin }, home }), /not inside a node_modules tree.*_npx/s)
})

test('nearestNodeModules: the closest node_modules above, within eight levels', () => {
  assert.equal(nearestNodeModules('/a/node_modules/@deepseek-ai/dsh/lib/bin.js'), '/a/node_modules')
  assert.equal(nearestNodeModules('/a/node_modules/b/node_modules/c/bin.js'), '/a/node_modules/b/node_modules')
  assert.equal(nearestNodeModules('/opt/homebrew/bin/dsh'), null)
  assert.equal(nearestNodeModules('/n/node_modules/1/2/3/4/5/6/7/8/9/bin.js'), null)
})
