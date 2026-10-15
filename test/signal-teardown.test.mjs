// The runner's response to a stopping signal (test/signal-teardown.mjs), PLAN-520.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { installSignalTeardown, STOP_SIGNALS } from './signal-teardown.mjs'

const NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }

/** Install against a fake process; `events` records the order everything happens in. */
function setup({ environments = new Map(), endGroups, exit } = {}) {
  const events = []
  const proc = new EventEmitter()
  const logged = []
  installSignalTeardown({
    environments,
    endGroups: endGroups ?? (async () => { events.push('groups ended'); return [] }),
    onSignal: (signal) => events.push(`onSignal ${signal}`),
    proc,
    log: (line) => logged.push(line),
    exit: exit ?? ((code) => events.push(`exit ${code}`)),
    signalNumber: (name) => NUMBERS[name],
  })
  return { proc, events, logged, environments }
}

/** An environment whose teardown is recorded and answers as given. */
function environment(events, name, result = { notes: [`released namespace ${name}`], problems: [] }) {
  return { teardown: async () => { events.push(`teardown ${name}`); return result } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the signals handled are the three that stop a run', () => {
  assert.deepEqual(STOP_SIGNALS, ['SIGINT', 'SIGTERM', 'SIGHUP'])
  const { proc } = setup()
  for (const signal of STOP_SIGNALS) assert.equal(proc.listenerCount(signal), 1, signal)
})

test('a signal ends the dsh runs, tears every unfinished scenario down, then exits 128 + the signal', async () => {
  const { proc, events, logged, environments } = setup()
  environments.set('/tmp/root-a', environment(events, 'ns-aaaa1111'))
  environments.set('/tmp/root-b', environment(events, 'ns-bbbb2222'))
  proc.emit('SIGTERM')
  await settle()
  assert.deepEqual(events, ['onSignal SIGTERM', 'groups ended', 'teardown ns-aaaa1111', 'teardown ns-bbbb2222', 'exit 143'])
  assert.deepEqual(logged, [
    '\ne2e: SIGTERM: tearing down 2 unfinished scenario(s)',
    '  teardown: released namespace ns-aaaa1111',
    '  teardown: released namespace ns-bbbb2222',
  ])
})

test('no scenario is torn down before the dsh runs have ended', async () => {
  let releaseGroups
  const { proc, events, environments } = setup({
    endGroups: () => new Promise((resolve) => { releaseGroups = () => { events.push('groups ended'); resolve([]) } }),
  })
  environments.set('/tmp/root', environment(events, 'ns-aaaa1111'))
  proc.emit('SIGINT')
  await settle()
  assert.deepEqual(events, ['onSignal SIGINT'], 'a serve still running would redial the daemon the teardown stops')
  releaseGroups()
  await settle()
  assert.deepEqual(events, ['onSignal SIGINT', 'groups ended', 'teardown ns-aaaa1111', 'exit 130'])
})

test('problems ending the dsh runs and tearing a scenario down are reported, with the root kept', async () => {
  const { proc, events, logged, environments } = setup({ endGroups: async () => ['process group 41 survived SIGKILL'] })
  environments.set('/tmp/root-a', environment(events, 'a', { notes: [], problems: ['could not release namespace ns-aaaa1111: boom'] }))
  proc.emit('SIGHUP')
  await settle()
  assert.deepEqual(logged.slice(1), [
    '  teardown: process group 41 survived SIGKILL',
    '  teardown: could not release namespace ns-aaaa1111: boom (kept: /tmp/root-a)',
  ])
  assert.equal(events.at(-1), 'exit 129')
})

test('a teardown that throws does not stop the others or the exit', async () => {
  const { proc, events, logged, environments } = setup()
  environments.set('/tmp/root-a', { teardown: async () => { throw new Error('plumb vanished') } })
  environments.set('/tmp/root-b', environment(events, 'ns-bbbb2222'))
  proc.emit('SIGTERM')
  await settle()
  assert.ok(logged.includes('  teardown: plumb vanished (kept: /tmp/root-a)'), logged.join('\n'))
  assert.ok(logged.includes('  teardown: released namespace ns-bbbb2222'))
  assert.equal(events.at(-1), 'exit 143')
})

test('a dsh teardown that fails outright does not skip the scenarios', async () => {
  const { proc, events, logged, environments } = setup({ endGroups: async () => { throw new Error('ps denied') } })
  environments.set('/tmp/root', environment(events, 'ns-aaaa1111'))
  proc.emit('SIGTERM')
  await settle()
  assert.ok(logged.includes('  teardown: could not end the dsh runs: ps denied'))
  assert.ok(events.includes('teardown ns-aaaa1111'), 'the namespace is still released')
  assert.equal(events.at(-1), 'exit 143')
})

test('the environments are read when the teardown starts, not when the signal arrived', async () => {
  let releaseGroups
  const { proc, events, environments } = setup({ endGroups: () => new Promise((resolve) => { releaseGroups = () => resolve([]) }) })
  environments.set('/tmp/root', environment(events, 'ns-aaaa1111'))
  proc.emit('SIGTERM')
  await settle()
  environments.delete('/tmp/root') // the scenario finished and tore itself down meanwhile
  releaseGroups()
  await settle()
  assert.ok(!events.includes('teardown ns-aaaa1111'), 'a finished scenario is not torn down twice')
  assert.equal(events.at(-1), 'exit 143')
})

test('with nothing in flight it still ends the dsh runs and exits', async () => {
  const { proc, events, logged } = setup()
  proc.emit('SIGINT')
  await settle()
  assert.deepEqual(events, ['onSignal SIGINT', 'groups ended', 'exit 130'])
  assert.equal(logged[0], '\ne2e: SIGINT: tearing down 0 unfinished scenario(s)')
})

test('each signal is handled once', async () => {
  const { proc, events, environments } = setup()
  environments.set('/tmp/root', environment(events, 'ns-aaaa1111'))
  proc.emit('SIGTERM')
  await settle()
  proc.emit('SIGTERM')
  await settle()
  assert.equal(events.filter((event) => event === 'teardown ns-aaaa1111').length, 1)
})

test('it does not exit before the teardown is done', async () => {
  let finish
  const events = []
  const slow = { teardown: () => new Promise((resolve) => { finish = () => { events.push('torn down'); resolve({ notes: [], problems: [] }) } }) }
  const { proc } = setup({ environments: new Map([['/tmp/root', slow]]), exit: (code) => events.push(`exit ${code}`) })
  proc.emit('SIGTERM')
  await settle()
  assert.deepEqual(events, [], 'still tearing down')
  finish()
  await settle()
  assert.deepEqual(events, ['torn down', 'exit 143'])
})
