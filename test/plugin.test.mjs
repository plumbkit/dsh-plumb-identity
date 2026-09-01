// Hermetic tests for the plumb-identity plugin: pure helpers plus the full
// wrap/stamp/declare flow against a stub SDK mounted at the real fixture
// paths. No DSH, no plumb, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = 'test'
const pluginUrl = new URL('../dsh-plumb-identity.mjs', import.meta.url)
const fixtureDshHome = join(here, 'fixtures/dshhome')
const fixtureSdkUrl = new URL('./fixtures/dshhome/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url).href

const { name, inject, defaultConfig, resolveAgentContext, mintIdentity, shouldSkip, apply } = await import(pluginUrl)
const { requests, fixtureState, Client } = await import(fixtureSdkUrl)

/**
 * Mount the plugin against the fixture SDK. Passing sdkPath routes the
 * apply-time import at the fixture — the same module instance this file
 * imported — so the shared `requests` log observes what the plugin does.
 * The plugin runs from the repo regardless of where node --test is invoked,
 * so DSH_HOME only has to point at the fixture tree, not resolve absolute
 * paths from this file's location.
 */
const mount = (ctx, extra = {}) => apply(ctx, { sdkPath: fixtureSdkUrl, ...extra })

test('plugin surface matches the cordis contract', () => {
  assert.equal(name, 'dsh-plumb-identity')
  assert.deepEqual(inject, ['tools'])
})

// -- resolveAgentContext ------------------------------------------------------

test('resolveAgentContext reads id and workspace from the verified field locations', () => {
  const exec = { name: 'mcp__plumb__daemon_info', agent: { id: 'conv-1234', session: { header: { id: 'conv-1234', cwd: '/w/a' } } } }
  assert.deepEqual(resolveAgentContext(exec), { sessionId: 'conv-1234', workspace: '/w/a', isSubagent: false })
})

test('resolveAgentContext flags subagents by lineage in the session header', () => {
  const byDepth = resolveAgentContext({ agent: { id: 'kid', session: { header: { cwd: '/w', delegationDepth: 1 } } } })
  const byParent = resolveAgentContext({ agent: { id: 'kid', session: { header: { cwd: '/w', parentSession: 'parent' } } } })
  assert.equal(byDepth.isSubagent, true)
  assert.equal(byParent.isSubagent, true)
  assert.equal(byDepth.sessionId, 'kid')
})

test('resolveAgentContext returns null for calls with no DSH session', () => {
  assert.equal(resolveAgentContext({ name: 'mcp__plumb__x' }), null)
  assert.equal(resolveAgentContext({ name: 'x', agent: {} }), null)
  assert.equal(resolveAgentContext(null), null)
})

// -- mintIdentity -------------------------------------------------------------

test('mintIdentity is deterministic and charset-safe', () => {
  const a = mintIdentity({ prefix: 'dsh', workspace: '/Users/g/Projects/plumb-ops', sessionId: 'session-6be95e20-e667-41ae' })
  const b = mintIdentity({ prefix: 'dsh', workspace: '/Users/g/Projects/plumb-ops', sessionId: 'session-6be95e20-e667-41ae' })
  assert.equal(a, b)
  assert.match(a, /^dsh-users-g-projects-plumb-ops-session-6be9/)
  assert.match(a, /^[a-z0-9-]+$/)
})

test('mintIdentity truncates long inputs and survives hostile ones', () => {
  const long = mintIdentity({ prefix: 'dsh', workspace: '/' + 'x/'.repeat(80), sessionId: 'y'.repeat(80) })
  assert.ok(long.length < 80, `unbounded id: ${long}`)
  const weird = mintIdentity({ prefix: 'dsh', workspace: 'C:\\Users\\Gilberto', sessionId: '___' })
  assert.match(weird, /^dsh-c-users-gilberto-anon$/)
  const empty = mintIdentity({ prefix: 'dsh', workspace: '/', sessionId: '' })
  assert.equal(empty, 'dsh-workspace-anon')
})

// -- shouldSkip ---------------------------------------------------------------

test('shouldSkip arms only on non-empty excluded env vars', () => {
  assert.equal(shouldSkip({ excludeEnv: ['PAUTA_RUN_ID'] }, { PAUTA_RUN_ID: 'r1' }), true)
  assert.equal(shouldSkip({ excludeEnv: ['PAUTA_RUN_ID'] }, { PAUTA_RUN_ID: '' }), false)
  assert.equal(shouldSkip({ excludeEnv: ['PAUTA_RUN_ID'] }, {}), false)
  assert.equal(shouldSkip(defaultConfig(), { PAUTA_RUN_ID: 'r1' }), true)
  assert.equal(shouldSkip({ excludeEnv: undefined }, { PAUTA_RUN_ID: 'r1' }), false)
})

test('defaultConfig carries the documented defaults', () => {
  assert.deepEqual(defaultConfig(), {
    serverName: 'plumb',
    idPrefix: 'dsh',
    purpose: 'dsh',
    subagentPurpose: 'dsh-subagent',
    detail: 'brief',
    excludeEnv: ['PAUTA_RUN_ID'],
    connectMarker: 'plumb',
    logEvents: false
  })
})

// -- the mounted plugin -------------------------------------------------------

/** A minimal cordis ctx: records listeners, logs, and plays dispose. */
function stubCtx () {
  const ctx = {
    logs: [],
    handlers: {},
    logger: {
      info: (msg) => ctx.logs.push(['info', msg]),
      warn: (msg) => ctx.logs.push(['warn', msg])
    },
    on (event, handler) { ctx.handlers[event] = handler }
  }
  return ctx
}

const conversation = (id, cwd, extra = {}) => ({ agent: { id, session: { header: { id, cwd, ...extra } } } })

test('wrap stamps _meta inside the identity scope and captures the instance', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const next = async () => {
      // The tool body's transport call: stamped because the scope is armed.
      const client = new Client()
      await client.request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'tool-result'
    }
    const result = await wrap({ name: 'mcp__plumb__daemon_info', ...conversation('conv-aaa', '/w/a') }, next)
    assert.equal(result, 'tool-result')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].params._meta['dev.plumbkit/logical-agent'], 'dsh-w-a-conv-aaa')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('second call issues exactly one proactive session_start with the right arguments, unstamped', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__workspace_sessions', ...conversation('conv-bbb', '/w/b') }
    // The first call's tool body runs inside the identity scope, so its
    // transport request stamps and captures the instance; no declaration is
    // possible yet because nothing was captured when the wrap checked.
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'workspace_sessions', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    // Second call: the wrap sees the captured instance and declares first.
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 1)
    assert.deepEqual(declares[0].params.arguments, {
      session_id: 'dsh-w-b-conv-bbb',
      workspace: '/w/b',
      purpose: 'dsh',
      detail: 'brief'
    })
    assert.equal(declares[0].params._meta, undefined, 'the proactive declaration must travel unstamped')
    await wrap(exec, async () => 'r3')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 1, 'declared once per session, not once per call')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('tools-sync capture lets the very first plumb call be declared first', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    // dsh-mcp-client connects its plumb server and syncs its tools long before
    // any agent exists; the first request through the instance — whose
    // transport names the `plumb serve` command — captures it.
    const client = new Client()
    await client.connect({ _serverParams: { command: '/opt/plumb/plumb', args: ['serve'] } })
    await client.request({ method: 'tools/list', params: {} }, { parse: (v) => v })
    assert.equal(Client.prototype.__plumbIdentityPatched, true, 'patch flag lives on Client.prototype')

    const wrap = ctx.handlers['tools/execute']
    await wrap({ name: 'mcp__plumb__daemon_info', ...conversation('conv-fff', '/w/f') }, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r'
    })
    const first = requests[1] // requests[0] is the captured instance's tools/list
    assert.equal(first.params.name, 'session_start', 'declaration precedes the first call')
    assert.equal(first.params.arguments.session_id, 'dsh-w-f-conv-fff')
    const second = requests[2]
    assert.equal(second.params.name, 'daemon_info')
    assert.equal(second.params._meta['dev.plumbkit/logical-agent'], 'dsh-w-f-conv-fff')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('subagents declare with their own id and the subagent purpose', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__session_start', ...conversation('kid-1', '/w/c', { delegationDepth: 1, parentSession: 'parent-1' }) }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'session_start', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    // The body's own request is also named session_start but carries no
    // arguments; the declaration is the one with arguments.
    const declare = requests.find((r) => r.params.name === 'session_start' && r.params.arguments?.session_id !== undefined)
    assert.equal(declare.params.arguments.session_id, 'dsh-w-c-kid-1')
    assert.equal(declare.params.arguments.purpose, 'dsh-subagent')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('non-plumb tools pass through with no stamping', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    let stampedInside = null
    await ctx.handlers['tools/execute']({ name: 'mcp__pauta__board_scan', ...conversation('conv-ccc', '/w/d') }, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'board_scan', arguments: {} } }, { parse: (v) => v })
      stampedInside = requests.at(-1).params._meta
      return 'r'
    })
    assert.equal(stampedInside, undefined)
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('calls with no DSH session pass through unstamped', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const result = await ctx.handlers['tools/execute']({ name: 'mcp__plumb__daemon_info' }, async () => 'r')
    assert.equal(result, 'r')
    assert.ok(ctx.logs.some(([level, msg]) => level === 'warn' && msg.includes('no DSH session')))
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('a refused declaration fails open and is retried on the next call', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  fixtureState.failSessionStart = true
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-eee', '/w/e') }
    // First call captures the instance (declaration not yet possible).
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    // Second call attempts the declaration; the stub refuses it before recording.
    const result = await wrap(exec, async () => 'r2')
    assert.equal(result, 'r2', 'the call proceeds despite the failed declaration')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 0)
    assert.ok(ctx.logs.some(([level, msg]) => level === 'warn' && msg.includes('failed')))
    fixtureState.failSessionStart = false
    await wrap(exec, async () => 'r3')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 1, 'retry after failure')
  } finally {
    fixtureState.failSessionStart = false
    await ctx.handlers.dispose?.()
  }
})

test('dispose restores the SDK prototype so apply can run again', async () => {
  process.env.DSH_HOME = fixtureDshHome
  const ctx = stubCtx()
  await mount(ctx)
  assert.equal(Client.prototype.__plumbIdentityPatched, true)
  await ctx.handlers.dispose?.()
  assert.equal(Client.prototype.__plumbIdentityPatched, undefined)
  const ctx2 = stubCtx()
  await mount(ctx2)
  assert.equal(Client.prototype.__plumbIdentityPatched, true)
  await ctx2.handlers.dispose?.()
})

test('excluded environments never mount anything', async () => {
  process.env.DSH_HOME = fixtureDshHome
  process.env.PAUTA_RUN_ID = 'run-1'
  try {
    const ctx = stubCtx()
    await mount(ctx)
    assert.equal(ctx.handlers['tools/execute'], undefined)
    assert.equal(Client.prototype.__plumbIdentityPatched, undefined)
    assert.ok(ctx.logs.some(([, msg]) => msg.includes('pauta')))
  } finally {
    delete process.env.PAUTA_RUN_ID
  }
})
