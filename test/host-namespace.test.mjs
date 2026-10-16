// The fourth kind of evidence for the e2e's host guard (test/separate-env.mjs):
// the owner's opt-in to a namespace run against the one daemon their own sessions
// use. The rule, the decision and the parser of `plumb debug daemons` are pure and
// tested here against their own vectors (fixtures/host-namespace-vectors.json);
// host-namespace-e2e.test.mjs drives the e2e itself.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  daemonsFromRun,
  explainHostNamespace,
  HOST_OPT_IN_ENV,
  hostDecision,
  hostNamespaceOptIn,
  parseDebugDaemons,
  refusal,
} from './separate-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'host-namespace-vectors.json'), 'utf8'))

// -- the rule, against its vectors -------------------------------------------------

test('the vectors cover every condition the rule names', () => {
  const conditions = new Set(VECTORS.cases.filter((c) => c.expect === null).map((c) => c.condition))
  assert.deepEqual([...conditions].sort(), ['authority', 'daemons', 'isolation', 'opt-in', 'pid', 'probe'])
  assert.ok(VECTORS.cases.some((c) => c.expect === 'host-namespace'), 'a happy path')
})

for (const c of VECTORS.cases) {
  test(`hostNamespaceOptIn: ${c.name}`, () => {
    const input = { env: c.env, isolation: c.isolation, probePassed: c.probePassed, daemons: c.daemons }
    assert.equal(hostNamespaceOptIn(input), c.expect)
    // A refusal names the condition that refused: a vector cannot pass by tripping
    // some other check than the one it is about.
    const why = explainHostNamespace(input)
    if (c.expect === null) {
      assert.equal(why?.condition, c.condition, `refused for ${why?.condition}: ${why?.why}`)
      assert.ok(typeof why.why === 'string' && why.why.length > 0, 'a refusal says why')
    } else {
      assert.equal(why, null)
    }
  })
}

test('the opt-in variable is DSH_E2E_HOST_DAEMON', () => {
  assert.equal(HOST_OPT_IN_ENV, 'DSH_E2E_HOST_DAEMON')
})

test('hostNamespaceOptIn does not read the process environment or the platform', () => {
  const before = process.env.DSH_E2E_HOST_DAEMON
  process.env.DSH_E2E_HOST_DAEMON = '48103'
  try {
    assert.equal(hostNamespaceOptIn({ env: {}, isolation: 'namespace', probePassed: true, daemons: [{ pid: 48103, authority: true }] }), null)
  } finally {
    if (before === undefined) delete process.env.DSH_E2E_HOST_DAEMON
    else process.env.DSH_E2E_HOST_DAEMON = before
  }
})

// -- the parser, against the real output ---------------------------------------------

for (const c of VECTORS.parserCases) {
  test(`parseDebugDaemons: ${c.name}`, () => {
    assert.deepEqual(parseDebugDaemons(`${c.lines.join('\n')}\n`), c.expect)
    // The final newline is not load-bearing.
    assert.deepEqual(parseDebugDaemons(c.lines.join('\n')), c.expect)
  })
}

test('parseDebugDaemons: the first fixture is the output of the real command, escapes included', () => {
  const lines = VECTORS.parserCases[0].lines
  assert.ok(lines.some((l) => l.includes('\u001b[')), 'colour escapes')
  assert.ok(lines.some((l) => /^ {2}PID {4}PPID {2}STARTED/.test(l.replace(/\u001b\[[0-9;]*m/g, ''))), 'the header')
})

test('parseDebugDaemons: anything that is not text is unreadable', () => {
  for (const value of [undefined, null, 48103, {}, ['  PID']]) assert.equal(parseDebugDaemons(value), null)
})

test('daemonsFromRun: only a clean exit is read', () => {
  const stdout = `${VECTORS.parserCases[0].lines.join('\n')}\n`
  const expected = [{ pid: 48103, authority: true }]
  assert.deepEqual(daemonsFromRun({ status: 0, signal: null, error: null, stdout }), expected)
  // plumb exits non-zero when the account does not have exactly one daemon that
  // holds the authority, or when a socket is not where the daemon published it,
  // or when the census could not read the process table: none of those is a
  // listing to act on, whatever the text says.
  assert.equal(daemonsFromRun({ status: 1, signal: null, error: null, stdout }), null)
  assert.equal(daemonsFromRun({ status: null, signal: 'SIGTERM', error: null, stdout }), null)
  assert.equal(daemonsFromRun({ status: 0, signal: null, error: new Error('ETIMEDOUT'), stdout }), null)
  assert.equal(daemonsFromRun({ status: null, signal: null, error: null, stdout }), null)
  assert.equal(daemonsFromRun(null), null)
})

// -- the decision, with a spy on everything it may do -----------------------------------

function spies({ isolation = 'namespace', probePassed = true, daemons = [{ pid: 48103, authority: true }] } = {}) {
  const calls = []
  const call = (name, value) => () => {
    calls.push(name)
    if (value instanceof Error) throw value
    return value
  }
  return { calls, isolation: call('isolation', isolation), probePassed: call('probePassed', probePassed), daemons: call('daemons', daemons) }
}

test('hostDecision: separate evidence allows and asks nobody anything', () => {
  for (const separate of ['github-actions', 'container', 'vm']) {
    const s = spies()
    const decision = hostDecision({ env: {}, separate, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
    assert.deepEqual(decision, { allow: true, kind: separate })
    assert.deepEqual(s.calls, [])
  }
})

test('hostDecision: separate evidence is used even when the opt-in is set (and the opt-in is not consulted)', () => {
  const s = spies({ isolation: 'daemon' })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '1' }, separate: 'container', isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.deepEqual(decision, { allow: true, kind: 'container' })
  assert.deepEqual(s.calls, [])
})

test('hostDecision: a plain host without the opt-in is refused before anything is asked', () => {
  const s = spies()
  const decision = hostDecision({ env: {}, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'opt-in')
  assert.match(decision.why, /DSH_E2E_HOST_DAEMON/)
  assert.deepEqual(s.calls, [])
})

test('hostDecision: a malformed opt-in is refused before anything is asked', () => {
  for (const value of ['', '0', '048103', ' 48103', '48103 ', 'true', '-1']) {
    const s = spies()
    const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: value }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
    assert.equal(decision.allow, false, JSON.stringify(value))
    assert.equal(decision.condition, 'opt-in', JSON.stringify(value))
    assert.deepEqual(s.calls, [], `${JSON.stringify(value)} asked ${s.calls}`)
  }
})

test('hostDecision: the opt-in with the daemon isolation is refused before the probe or the listing', () => {
  const s = spies({ isolation: 'daemon' })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'isolation')
  assert.match(decision.why, /namespace isolation only/)
  assert.deepEqual(s.calls, ['isolation'])
})

test('hostDecision: an isolation that cannot be selected refuses, and says why', () => {
  const s = spies({ isolation: new Error('E2E_ISOLATION="bogus" is not an isolation') })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'isolation')
  assert.match(decision.why, /bogus/)
  assert.deepEqual(s.calls, ['isolation'])
})

test('hostDecision: a failed probe is refused before the listing is read', () => {
  const s = spies({ probePassed: false })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'probe')
  assert.deepEqual(s.calls, ['isolation', 'probePassed'])
})

test('hostDecision: a probe that throws is a refusal, not a crash', () => {
  const s = spies({ probePassed: new Error('no plumb binary found') })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'probe')
  assert.match(decision.why, /no plumb binary found/)
  assert.deepEqual(s.calls, ['isolation', 'probePassed'])
})

test('hostDecision: a listing that cannot be read is a refusal', () => {
  for (const daemons of [null, new Error('spawn ETIMEDOUT')]) {
    const s = spies({ daemons })
    const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
    assert.equal(decision.allow, false)
    assert.equal(decision.condition, 'daemons')
    assert.deepEqual(s.calls, ['isolation', 'probePassed', 'daemons'])
  }
})

test('hostDecision: every condition met allows, and names the daemon', () => {
  const s = spies()
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.deepEqual(decision, { allow: true, kind: 'host-namespace', pid: 48103 })
  assert.deepEqual(s.calls, ['isolation', 'probePassed', 'daemons'])
})

test('hostDecision: a stale PID (the daemon restarted since the recipe was written) is refused and says so', () => {
  const s = spies({ daemons: [{ pid: 51000, authority: true }] })
  const decision = hostDecision({ env: { DSH_E2E_HOST_DAEMON: '48103' }, separate: null, isolation: s.isolation, probePassed: s.probePassed, daemons: s.daemons })
  assert.equal(decision.allow, false)
  assert.equal(decision.condition, 'pid')
  assert.match(decision.why, /48103/)
  assert.match(decision.why, /51000/)
  assert.match(decision.why, /plumb debug daemons/)
})

test('hostDecision agrees with hostNamespaceOptIn on every vector', () => {
  for (const c of VECTORS.cases) {
    const decision = hostDecision({ env: c.env, separate: null, isolation: () => c.isolation, probePassed: () => c.probePassed, daemons: () => c.daemons })
    assert.equal(decision.allow, c.expect === 'host-namespace', c.name)
    if (decision.allow) assert.equal(decision.kind, 'host-namespace', c.name)
    else assert.equal(decision.condition, c.condition, c.name)
  }
})

// -- the refusal text ----------------------------------------------------------------------

test('the refusal still says what it said, and now names the opt-in and how to find the PID', () => {
  const text = refusal('e2e')
  assert.match(text, /refusing to run here/)
  assert.match(text, /not to start, stop or write namespaces into/)
  assert.match(text, /GITHUB_ACTIONS=true/)
  assert.match(text, /PLUMB_SEPARATE_ENV=vm/)
  assert.match(text, /DSH_E2E_HOST_DAEMON=<pid>/)
  assert.match(text, /plumb debug daemons/)
  assert.match(text, /namespace isolation only/)
})
