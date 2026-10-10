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

const { name, inject, defaultConfig, resolveAgentContext, mintIdentity, shouldSkip, apply, resolvePlumbCommand, mcpContentText, refusesMailPreview } = await import(pluginUrl)
const { requests, toolCalls, clients, fixtureState, Client } = await import(fixtureSdkUrl)
const { spawned, instances } = await import(new URL('./fixtures/dshhome/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js', import.meta.url).href)

/**
 * Mount the plugin against the fixture SDK. Passing sdkPath routes the
 * apply-time import at the fixture — the same module instance this file
 * imported — so the shared `requests` log observes what the plugin does.
 * The plugin runs from the repo regardless of where node --test is invoked,
 * so DSH_HOME only has to point at the fixture tree, not resolve absolute
 * paths from this file's location.
 *
 * `mount` pins the SHARED-connection path (`perAgentConnection: false`), which
 * is both the historic behaviour and the live fallback, so its tests keep
 * pinning the stamping contract. `mountPerAgent` exercises the default path —
 * one `plumb serve` per agent — against the fixture's stdio transport.
 */
const mount = (ctx, extra = {}) => apply(ctx, { sdkPath: fixtureSdkUrl, perAgentConnection: false, ...extra })
const mountPerAgent = (ctx, extra = {}) => apply(ctx, { sdkPath: fixtureSdkUrl, perAgentConnection: true, ...extra })

/** Every fixture-side record the per-agent tests assert on. */
function resetFixture () {
  requests.length = 0
  toolCalls.length = 0
  spawned.length = 0
  clients.length = 0
  instances.length = 0
  fixtureState.toolResults = {}
  fixtureState.failToolCall = false
  fixtureState.listedTools = ['session_start', 'read_file', 'edit_file', 'write_file', 'daemon_info']
}

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
    logEvents: false,
    perAgentConnection: true,
    plumbCommand: '',
    plumbArgs: ['serve'],
    maxConnections: 16,
    idleMs: 15_000
  })
})

test('resolvePlumbCommand prefers config, then $PLUMB_BIN, then PATH', () => {
  assert.equal(resolvePlumbCommand({ plumbCommand: '/opt/plumb' }, { PLUMB_BIN: '/env/plumb' }), '/opt/plumb')
  assert.equal(resolvePlumbCommand({ plumbCommand: '' }, { PLUMB_BIN: '/env/plumb' }), '/env/plumb')
  assert.equal(resolvePlumbCommand({ plumbCommand: '' }, {}), 'plumb')
})

test('mcpContentText mirrors the bridge: text joined, other blocks named', () => {
  assert.equal(mcpContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'read_file'), 'a\nb')
  assert.match(mcpContentText([{ type: 'image', data: 'x' }], 'read_file'), /read_file: image content is not rendered/)
  assert.equal(mcpContentText(undefined, 'read_file'), '')
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

test('a plumb call that travels through the patched client reports no identity fault', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    // Control for the test below: this is a healthy install — the tool body's
    // request goes through the class the plugin patched — so the warning about
    // an unreachable patch must stay silent.
    await wrap({ name: 'mcp__plumb__daemon_info', ...conversation('conv-ok', '/w/ok') }, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'tool-result'
    })
    assert.equal(
      ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('nothing stamped')).length,
      0,
      'a stamped call must not be reported as an identity fault'
    )
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('a plumb call that never reaches the patched client is reported once, naming the patched path', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-lost', '/w/lost') }
    // The install this warning exists for: dsh-mcp-client resolves a different
    // @modelcontextprotocol package — or a different major of it — from the one
    // patched above, so no request ever passes through the patched class and
    // `plumbClientRef` is never captured. The plugin cannot see the cause, only
    // the effect: a plumb call completed and nothing was stamped. Simulated by
    // a tool body that reaches its transport by some other route.
    await wrap(exec, async () => 'tool-result')
    await wrap(exec, async () => 'tool-result')

    const warns = ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('nothing stamped'))
    assert.equal(warns.length, 1, 'a property of the install is reported once, not once per call')
    assert.match(warns[0][1], /not on the running client's request path/)
    assert.match(warns[0][1], /client\/index\.js/, 'names the path it patched, which is the whole diagnosis')
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
      detail: 'brief',
      // An automatic session_start must never CLAIM mail into a packet the model
      // does not read (PLAN-500).
      mail: 'preview'
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
    assert.ok(ctx.logs.some(([level, msg]) => level === 'warn' && msg.includes('could not be sent')))
    fixtureState.failSessionStart = false
    await wrap(exec, async () => 'r3')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 1, 'retry after failure')
  } finally {
    fixtureState.failSessionStart = false
    await ctx.handlers.dispose?.()
  }
})

// -- two agents on one connection ---------------------------------------------
//
// The shape the plugin exists for: ONE `plumb serve`, two DSH conversations in
// two workspaces. Each must declare itself, keep its own identity on every call,
// and — when plumb refuses one of them — the refusal must be handled per its
// scope rather than for the connection as a whole.

test('two conversations on one connection keep their own identity and outcome', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const agentA = { name: 'mcp__plumb__daemon_info', ...conversation('conv-a', '/w/a') }
    const agentB = { name: 'mcp__plumb__workspace_sessions', ...conversation('conv-b', '/w/b') }

    // One client — one `plumb serve` — captured by the first call's body.
    await wrap(agentA, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r0'
    })
    // Agent A's own declaration lands.
    await wrap(agentA, async () => 'r1')

    // Agent B's declaration is refused at CONNECTION scope: force there would move
    // the pin every agent on this connection resolves against, so it must not be
    // sent automatically.
    fixtureState.sessionStartRefusals = [{ kind: 'pin_refused', details: { scope: 'connection', pinned: '/w/a', requested: '/w/b' } }]
    await wrap(agentB, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'workspace_sessions', arguments: {} } }, { parse: (v) => v })
      return 'r2'
    })

    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 2, 'one declaration attempt per agent')
    assert.deepEqual(declares.map((r) => r.params.arguments.session_id), ['dsh-w-a-conv-a', 'dsh-w-b-conv-b'])
    assert.deepEqual(declares.map((r) => r.params.arguments.workspace), ['/w/a', '/w/b'])
    assert.ok(declares.every((r) => r.params.arguments.force === undefined), 'no forced retry at connection scope')

    // Every call carried its OWN agent id, so plumb attributed it correctly even
    // though the two share one transport.
    const stamped = requests.filter((r) => r.params._meta?.['dev.plumbkit/logical-agent'] !== undefined)
    const ids = new Set(stamped.map((r) => r.params._meta['dev.plumbkit/logical-agent']))
    assert.ok(ids.has('dsh-w-a-conv-a') && ids.has('dsh-w-b-conv-b'), `both agents stamped their own id: ${[...ids].join(', ')}`)

    const warns = ctx.logs.filter(([level]) => level === 'warn')
    assert.equal(warns.length, 1, 'the refusal is reported exactly once, for agent B')
    assert.match(warns[0][1], /refused the declaration for dsh-w-b-conv-b/)
    assert.match(warns[0][1], /connection pin belongs to another workspace/)
  } finally {
    fixtureState.sessionStartRefusals = []
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

// -- refused declarations -----------------------------------------------------
//
// A refusal is a normal tools/call RESULT whose isError is true, and plumb's
// _meta envelope says WHICH pin it refused to move. The two scopes need
// opposite handling, so these pin both.

test('a connection-scope refusal is surfaced, never auto-forced, and not retried', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  fixtureState.sessionStartRefusals = [{
    kind: 'pin_refused',
    retryable: true,
    remediation: { class: 'repin_workspace', tool: 'session_start' },
    details: { scope: 'connection', pinned: '/w/other', requested: '/w/g' }
  }]
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-conn', '/w/g') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 1, 'a connection-scope refusal is attempted once')
    assert.equal(declares[0].params.arguments.force, undefined, 'force must never be sent at connection scope')
    const warns = ctx.logs.filter(([level]) => level === 'warn')
    assert.equal(warns.length, 1, 'reported exactly once')
    assert.match(warns[0][1], /refused the declaration/)
    assert.match(warns[0][1], /connection pin belongs to another workspace/)
    await wrap(exec, async () => 'r3')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 1, 'a refusal is not re-attempted every call')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test('an agent-scope refusal is retried exactly once with force, then counts as declared', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  fixtureState.sessionStartRefusals = [{ kind: 'pin_refused', retryable: true, details: { scope: 'agent', pinned: '/w/other', requested: '/w/h' } }]
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-agent', '/w/h') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 2, 'one plain attempt, one forced retry')
    assert.equal(declares[0].params.arguments.force, undefined)
    assert.equal(declares[1].params.arguments.force, true, 'agent scope is the only scope a forced retry is safe at')
    assert.ok(ctx.logs.some(([level, msg]) => level === 'info' && msg.includes('after a per-agent re-pin refusal')))
    assert.equal(ctx.logs.filter(([level]) => level === 'warn').length, 0, 'a recovered refusal is not a warning')
    await wrap(exec, async () => 'r3')
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 2, 'a recovered declaration is not repeated')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test('two simultaneous first calls from one agent issue one declaration', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-race', '/w/i') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await Promise.all([
      wrap(exec, async () => 'r2'),
      wrap(exec, async () => 'r3'),
      wrap(exec, async () => 'r4')
    ])
    assert.equal(requests.filter((r) => r.params.name === 'session_start').length, 1, 'concurrent first calls share one in-flight declaration')
  } finally {
    await ctx.handlers.dispose?.()
  }
})


// -- per-agent connections (the default path) --------------------------------

test("a plumb call runs over the agent's OWN connection, never the shared one", async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = {
      name: 'mcp__plumb__read_file',
      arguments: { file_path: '/w/own/x.go' },
      ...conversation('conv-own', '/w/own')
    }
    const result = await wrap(exec, async () => {
      throw new Error('the shared connection must not be used')
    })

    // One connection, spawned as a plumb proxy inside the agent's workspace.
    assert.equal(spawned.length, 1, 'exactly one connection for one agent')
    assert.deepEqual(spawned[0].args, ['serve'])
    assert.equal(spawned[0].cwd, '/w/own')

    // Declared on that connection, with this agent's minted id and workspace,
    // previewing mail rather than claiming it: this is the DEFAULT path, so it is
    // the one that loses a note if the argument goes missing (PLAN-500).
    const declare = toolCalls.find((call) => call.name === 'session_start')
    assert.deepEqual(declare.arguments, {
      session_id: 'dsh-w-own-conv-own',
      workspace: '/w/own',
      purpose: 'dsh',
      detail: 'brief',
      mail: 'preview'
    })

    // The call itself went over the SAME client instance.
    const invoked = toolCalls.find((call) => call.name === 'read_file')
    assert.equal(invoked.clientId, declare.clientId)
    assert.deepEqual(invoked.arguments, { file_path: '/w/own/x.go' })

    // Canonical value + model-facing content, as @deepseek-ai/dsh-mcp-client builds them.
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { content: [{ type: 'text', text: 'per-agent read_file' }] })
    assert.deepEqual(result.content, [{ type: 'text', text: 'per-agent read_file' }])

    // And nothing travelled over the shared connection.
    assert.equal(requests.length, 0)
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('each agent gets its own connection, declared with its own id and purpose', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    await wrap({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-a', '/w/a') }, async () => 'shared')
    await wrap({
      name: 'mcp__plumb__read_file',
      arguments: {},
      ...conversation('conv-b', '/w/b', { parentSession: 'conv-a', delegationDepth: 1 })
    }, async () => 'shared')

    assert.equal(spawned.length, 2, 'one connection per agent, not one per process')
    assert.deepEqual(spawned.map((s) => s.cwd), ['/w/a', '/w/b'])

    const declared = toolCalls.filter((call) => call.name === 'session_start')
    assert.deepEqual(declared.map((call) => call.arguments.session_id), ['dsh-w-a-conv-a', 'dsh-w-b-conv-b'])
    assert.deepEqual(declared.map((call) => call.arguments.purpose), ['dsh', 'dsh-subagent'])
    assert.notEqual(declared[0].clientId, declared[1].clientId, "a subagent is not declared on its parent's connection")
    assert.equal(requests.length, 0, 'no agent fell back to the shared connection')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('concurrent first calls from one agent open one connection together', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', arguments: {}, ...conversation('conv-race', '/w/r') }
    await Promise.all([
      wrap(exec, async () => 'shared'),
      wrap(exec, async () => 'shared'),
      wrap(exec, async () => 'shared')
    ])
    assert.equal(spawned.length, 1)
    assert.equal(toolCalls.filter((call) => call.name === 'session_start').length, 1, 'one declaration per agent, not one per call')
    assert.equal(toolCalls.filter((call) => call.name === 'daemon_info').length, 3)
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('a dispatched call that fails is NOT retried on the shared connection', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.toolResults = {
    write_file: { isError: true, content: [{ type: 'text', text: 'write_file: refused — the file is dirty' }] }
  }
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    let sharedRuns = 0
    await assert.rejects(
      () => wrap(
        { name: 'mcp__plumb__write_file', arguments: { file_path: '/w/x' }, ...conversation('conv-err', '/w/e') },
        async () => { sharedRuns += 1; return 'shared' }
      ),
      /refused — the file is dirty/
    )
    assert.equal(sharedRuns, 0, 'plumb writes are not idempotent: a sent call must never be re-sent')
    assert.equal(requests.length, 0)
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test("a tool the agent's connection does not advertise falls back to the shared client", async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.listedTools = ['session_start', 'daemon_info']
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    let sharedRuns = 0
    const result = await wrap(
      { name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-unk', '/w/u') },
      async () => { sharedRuns += 1; return 'shared-result' }
    )
    assert.equal(result, 'shared-result', 'an unknown name is dispatched before anything is sent')
    assert.equal(sharedRuns, 1)
    assert.equal(toolCalls.filter((call) => call.name === 'read_file').length, 0, 'the per-agent connection was never asked')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('dispose closes every per-agent connection', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  const wrap = ctx.handlers['tools/execute']
  await wrap({ name: 'mcp__plumb__daemon_info', arguments: {}, ...conversation('conv-close', '/w/c') }, async () => 'shared')
  assert.equal(instances.length, 1)
  assert.equal(instances[0].closed, false)
  await ctx.handlers.dispose?.()
  assert.equal(instances[0].closed, true, 'the transport is closed on dispose')
  assert.ok(clients.every((client) => client.closed === true), 'the client is closed on dispose')
})

// -- plumb older than 0.24 (no `mail` argument) ---------------------------------
//
// plumb's argument guard refuses a parameter it does not know with an ordinary
// tool error, so a plumb that predates session_start's `mail` refuses the whole
// declaration. Without a fallback, adding `mail: 'preview'` would leave every
// agent undeclared on such a daemon, which is worse than claiming mail.

const oldPlumbRefusal = () => ({
  kind: 'invalid_arguments',
  refusalText: 'session_start: unknown parameter "mail". Valid parameters: session_id, workspace, purpose, detail, force'
})

const pinRefusal = () => ({
  kind: 'pin_refused',
  retryable: true,
  remediation: { class: 'repin_workspace', tool: 'session_start' },
  details: { scope: 'connection', pinned: '/w/other', requested: '/w/m' }
})

test('refusesMailPreview matches only an unknown `mail` parameter', () => {
  const text = (t) => [{ type: 'text', text: t }]
  assert.equal(refusesMailPreview({ isError: true, content: text('session_start: unknown parameter "mail". Valid parameters: session_id') }), true)
  assert.equal(refusesMailPreview({ isError: false, content: text('unknown parameter "mail"') }), false, 'a success is never a refusal')
  assert.equal(refusesMailPreview({ isError: true, content: text('session_start: unknown parameter "force"') }), false, 'another unknown parameter is not this one')
  assert.equal(refusesMailPreview({ isError: true, content: text('refused') }), false)
  assert.equal(refusesMailPreview(undefined), false)
})

test('shared connection: an older plumb refusing `mail` is retried once without it, and remembered', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  fixtureState.sessionStartRefusals = [oldPlumbRefusal()]
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-old', '/w/m') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 2, 'refused once, then retried once')
    assert.equal(declares[0].params.arguments.mail, 'preview')
    assert.equal('mail' in declares[1].params.arguments, false, 'the retry omits mail')
    assert.equal(declares[1].params.arguments.session_id, 'dsh-w-m-conv-old', 'the retry is the same declaration')
    assert.ok(ctx.logs.some(([level, msg]) => level === 'info' && msg.includes('declared dsh-w-m-conv-old')), 'the agent ends up declared')
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('predates')).length, 1)
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('refused the declaration')).length, 0, 'the fallback is not reported as a refusal')

    // A second agent on the same client goes straight to the form it accepts.
    const other = { name: 'mcp__plumb__daemon_info', ...conversation('conv-old2', '/w/m') }
    await wrap(other, async () => 'r3')
    const after = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(after.length, 3, 'one declaration for the second agent, no second refusal')
    assert.equal('mail' in after[2].params.arguments, false)
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('predates')).length, 1, 'warned once, not per agent')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test('shared connection: an agent-scope refusal after the mail fallback is forced WITHOUT mail', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  // An older plumb that also refuses the pin at agent scope: the fallback's
  // mail-less retry is refused, and the forced retry must stay mail-less too.
  fixtureState.sessionStartRefusals = [
    oldPlumbRefusal(),
    { kind: 'pin_refused', retryable: true, details: { scope: 'agent', pinned: '/w/other', requested: '/w/m' } }
  ]
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-old-force', '/w/m') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 3, 'with mail, then without, then forced')
    assert.equal(declares[0].params.arguments.mail, 'preview')
    assert.equal('mail' in declares[1].params.arguments, false)
    assert.equal(declares[1].params.arguments.force, undefined)
    assert.equal('mail' in declares[2].params.arguments, false, 'an older plumb would refuse a forced retry that carried mail')
    assert.equal(declares[2].params.arguments.force, true)
    assert.ok(ctx.logs.some(([level, msg]) => level === 'info' && msg.includes('after a per-agent re-pin refusal')), 'the agent ends up declared')
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('refused the declaration')).length, 0)
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test('shared connection: any other refusal does not trigger the mail fallback', async () => {
  process.env.DSH_HOME = fixtureDshHome
  requests.length = 0
  fixtureState.sessionStartRefusals = [pinRefusal()]
  const ctx = stubCtx()
  await mount(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const exec = { name: 'mcp__plumb__daemon_info', ...conversation('conv-pin', '/w/m') }
    await wrap(exec, async () => {
      await new Client().request({ method: 'tools/call', params: { name: 'daemon_info', arguments: {} } }, { parse: (v) => v })
      return 'r1'
    })
    await wrap(exec, async () => 'r2')
    const declares = requests.filter((r) => r.params.name === 'session_start')
    assert.equal(declares.length, 1, 'a pin refusal is not retried as a mail fallback')
    assert.equal(declares[0].params.arguments.mail, 'preview')
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('predates')).length, 0)
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('refused the declaration')).length, 1, 'still reported as the refusal it is')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test("per-agent connection: an older plumb refusing `mail` is retried once without it on the agent's own client", async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.sessionStartRefusals = [oldPlumbRefusal()]
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    const result = await wrap(
      { name: 'mcp__plumb__read_file', arguments: { file_path: '/w/m/x.go' }, ...conversation('conv-pa-old', '/w/m') },
      async () => { throw new Error('the shared connection must not be used') }
    )
    const declares = toolCalls.filter((call) => call.name === 'session_start')
    assert.equal(declares.length, 2, 'refused once, then retried once')
    assert.equal(declares[0].arguments.mail, 'preview')
    assert.equal('mail' in declares[1].arguments, false, 'the retry omits mail')
    assert.equal(declares[1].clientId, declares[0].clientId, "the retry stays on the agent's own client")
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('predates')).length, 1)
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('refused the declaration')).length, 0)
    assert.equal(result.isError, false, 'the call itself still goes through')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

test('per-agent connection: any other refusal is reported, not retried as a mail fallback', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.sessionStartRefusals = [pinRefusal()]
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    await wrap(
      { name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-pa-pin', '/w/m') },
      async () => 'shared'
    )
    const declares = toolCalls.filter((call) => call.name === 'session_start')
    assert.equal(declares.length, 1, 'no mail fallback for a pin refusal')
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('predates')).length, 0)
    const refused = ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('refused the declaration of dsh-w-m-conv-pa-pin'))
    assert.equal(refused.length, 1, 'a refusal on the own connection is reported, not silently ignored')
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})
