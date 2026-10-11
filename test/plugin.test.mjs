// Hermetic tests for the plumb-identity plugin: pure helpers plus the full
// wrap/stamp/declare flow against a stub SDK mounted at the real fixture
// paths. No DSH, no plumb, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = 'test'
const pluginUrl = new URL('../dsh-plumb-identity.mjs', import.meta.url)
const fixtureDshHome = join(here, 'fixtures/dshhome')
const fixtureSdkUrl = new URL('./fixtures/dshhome/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url).href

const {
  name, inject, defaultConfig, resolveAgentContext, mintIdentity, shouldSkip, apply, resolvePlumbCommand, mcpContentText, refusesMailPreview,
  resumeProofArgs, resumeProofRequest, resumeProofFields, resumeProofEnv, runResumeProof,
  normaliseSessionStart, findOwnSdkRoot, defaultSdkRoot
} = await import(pluginUrl)
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

/**
 * The per-agent path runs plumb's identity hook for the resume proof, so its
 * mount names a fake of that hook as the plumb command: the fixture transport
 * never spawns the serve, but the proof is a real child process, and it must
 * not be the developer's plumb.
 */
const fakeHook = fileURLToPath(new URL('./fixtures/fake-plumb-hook.mjs', import.meta.url))
const mountPerAgent = (ctx, extra = {}) => apply(ctx, { sdkPath: fixtureSdkUrl, perAgentConnection: true, plumbCommand: fakeHook, ...extra })

/** Every fixture-side record the per-agent tests assert on. */
function resetFixture () {
  requests.length = 0
  toolCalls.length = 0
  spawned.length = 0
  clients.length = 0
  instances.length = 0
  fixtureState.toolResults = {}
  fixtureState.failToolCall = false
  fixtureState.toolCallDelayMs = 0
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
    idleMs: 15_000,
    resumeProof: true,
    resumeProofTimeoutMs: 5_000,
    normaliseDeclarations: true
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
    // the one that loses a note if the argument goes missing (PLAN-500). It also
    // carries the hook's stamp and resume proof, without which a reconnect
    // gives the agent a new plumb session (PLAN-510).
    const declare = toolCalls.find((call) => call.name === 'session_start')
    assert.deepEqual(declare.arguments, {
      session_id: 'dsh-w-own-conv-own',
      workspace: '/w/own',
      purpose: 'dsh',
      detail: 'brief',
      mail: 'preview',
      plumb_agent: 'dsh-w-own-conv-own',
      plumb_hook_proof: 'proof-of-dsh-w-own-conv-own'
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

// -- resume proof (PLAN-510) ---------------------------------------------------

const proofLog = () => join(fileURLToPath(new URL('.', import.meta.url)), `.fake-hook-${process.pid}-${Math.random().toString(36).slice(2)}.log`)

async function readProofLog (file) {
  const { readFile, rm } = await import('node:fs/promises')
  const text = await readFile(file, 'utf8').catch(() => '')
  await rm(file, { force: true })
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Run fn with process.env overrides, restoring them afterwards. */
async function withEnv (overrides, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('resumeProofRequest is a PreToolUse session_start naming the id, under the name the hook matches', () => {
  assert.deepEqual(resumeProofArgs, ['hooks', 'run-claude'])
  assert.deepEqual(resumeProofRequest('dsh-a-b'), {
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__plumb__session_start',
    session_id: 'dsh-a-b',
    tool_input: { session_id: 'dsh-a-b' }
  })
})

test('resumeProofFields keeps only the stamp and the proof, for exactly this id', () => {
  const out = (updatedInput) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })
  assert.deepEqual(
    resumeProofFields('x', out({ session_id: 'x', plumb_agent: 'x', plumb_hook_proof: 'p', workspace: '/elsewhere' })),
    { plumb_agent: 'x', plumb_hook_proof: 'p' },
    'anything else the hook echoes is not taken'
  )
  assert.deepEqual(
    resumeProofFields('x', out({ session_id: 'x', 'dev.plumbkit/logical-agent': 'x', plumb_hook_proof: 'p' })),
    { 'dev.plumbkit/logical-agent': 'x', plumb_hook_proof: 'p' },
    "an older daemon's stamp key"
  )
  // Each of these is a declaration that goes out unproved.
  assert.equal(resumeProofFields('x', ''), null, 'a silent hook')
  assert.equal(resumeProofFields('x', 'not json'), null)
  assert.equal(resumeProofFields('x', 'null'), null)
  assert.equal(resumeProofFields('x', out({ session_id: 'x', plumb_agent: 'x' })), null, 'stamped but no proof')
  assert.equal(resumeProofFields('x', out({ session_id: 'x', plumb_agent: 'x', plumb_hook_proof: '' })), null, 'an empty proof')
  assert.equal(resumeProofFields('x', out({ session_id: 'x', plumb_agent: 'x', plumb_hook_proof: 7 })), null, 'a proof that is not a string')
  assert.equal(resumeProofFields('x', out({ session_id: 'y', plumb_agent: 'y', plumb_hook_proof: 'p' })), null, "another id's proof")
  assert.equal(resumeProofFields('x', out({ session_id: 'x', plumb_agent: 'y', plumb_hook_proof: 'p' })), null, 'a stamp for another id')
  assert.equal(resumeProofFields('x', out({ session_id: 'y', plumb_agent: 'x', plumb_hook_proof: 'p' })), null, 'a session_start the hook re-pointed at another id')
  assert.equal(resumeProofFields('x', out({ session_id: 'x', plumb_hook_proof: 'p' })), null, 'a proof with no stamp')
})

test("resumeProofEnv drops plumb's Claude Code hook switch and nothing else", () => {
  assert.deepEqual(resumeProofEnv({ PATH: '/bin', PLUMB_IDENTITY_HOOK: 'off', HOME: '/h', UNSET: undefined }), { PATH: '/bin', HOME: '/h' })
})

test('runResumeProof runs plumb hooks run-claude and returns its proof', async () => {
  const log = proofLog()
  const got = await runResumeProof(fakeHook, 'dsh-w-p', resumeProofEnv({ ...process.env, FAKE_PLUMB_HOOK_LOG: log, PLUMB_IDENTITY_HOOK: 'off' }), 5_000)
  assert.deepEqual(got, { fields: { plumb_agent: 'dsh-w-p', plumb_hook_proof: 'proof-of-dsh-w-p' }, why: '' })
  const runs = await readProofLog(log)
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].argv, ['hooks', 'run-claude'])
  assert.deepEqual(runs[0].event, resumeProofRequest('dsh-w-p'))
  assert.equal(runs[0].killSwitch, null, 'the Claude Code kill switch never reaches the hook')
})

test('runResumeProof fails open: silence, a stall and a missing binary each give no proof and a reason', async () => {
  const silent = await runResumeProof(fakeHook, 'id', { ...process.env, FAKE_PLUMB_HOOK: 'silent' }, 5_000)
  assert.equal(silent.fields, null)
  assert.match(silent.why, /fake: no daemon answered/, "the hook's own reason is reported")

  const stampedOnly = await runResumeProof(fakeHook, 'id', { ...process.env, FAKE_PLUMB_HOOK: 'noproof' }, 5_000)
  assert.equal(stampedOnly.fields, null, 'a stamp with no proof is not taken')
  assert.equal(stampedOnly.why, 'the hook returned no proof')

  const mismatch = await runResumeProof(fakeHook, 'id', { ...process.env, FAKE_PLUMB_HOOK: 'mismatch' }, 5_000)
  assert.equal(mismatch.fields, null)

  const started = Date.now()
  const stalled = await runResumeProof(fakeHook, 'id', { ...process.env, FAKE_PLUMB_HOOK: 'stall' }, 300)
  assert.equal(stalled.fields, null)
  assert.match(stalled.why, /did not answer within 300 ms/)
  assert.ok(Date.now() - started < 3_000, 'the timeout bounds the wait')

  const missing = await runResumeProof('/nonexistent/plumb', 'id', process.env, 5_000)
  assert.equal(missing.fields, null)
  assert.match(missing.why, /could not (run|start) \/nonexistent\/plumb/)
})

test('per-agent connection: with no proof the declaration goes out unproved, warned once per process', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  // The real hook's answer for a daemon that takes no proof: stamped, unproved.
  await withEnv({ FAKE_PLUMB_HOOK: 'noproof' }, async () => {
    const ctx = stubCtx()
    await mountPerAgent(ctx)
    try {
      const wrap = ctx.handlers['tools/execute']
      await wrap({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-np-a', '/w/np') }, async () => 'shared')
      await wrap({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-np-b', '/w/np') }, async () => 'shared')
      const declares = toolCalls.filter((call) => call.name === 'session_start')
      assert.equal(declares.length, 2)
      for (const call of declares) {
        assert.equal('plumb_hook_proof' in call.arguments, false)
        assert.equal('plumb_agent' in call.arguments, false)
        assert.equal(call.arguments.mail, 'preview', 'the declaration is otherwise unchanged')
      }
      const warned = ctx.logs.filter(([level, msg]) => level === 'warn' && msg.includes('no resume proof'))
      assert.equal(warned.length, 1, 'once per process, not once per connection')
      assert.match(warned[0][1], /the hook returned no proof/)
    } finally {
      await ctx.handlers.dispose?.()
    }
  })
})

test('per-agent connection: a resumeProofTimeoutMs that is not a positive number falls back to the default', async () => {
  process.env.DSH_HOME = fixtureDshHome
  for (const bad of [0, -1, Number.NaN, 'soon']) {
    resetFixture()
    const ctx = stubCtx()
    await mountPerAgent(ctx, { resumeProofTimeoutMs: bad })
    try {
      await ctx.handlers['tools/execute']({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation(`conv-to-${String(bad)}`, '/w/to') }, async () => 'shared')
      const declare = toolCalls.find((call) => call.name === 'session_start')
      assert.equal(typeof declare.arguments.plumb_hook_proof, 'string', `timeout ${String(bad)} still lets the hook answer`)
    } finally {
      await ctx.handlers.dispose?.()
    }
  }
})

test('per-agent connection: resumeProof false never runs the hook', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const log = proofLog()
  await withEnv({ FAKE_PLUMB_HOOK_LOG: log }, async () => {
    const ctx = stubCtx()
    await mountPerAgent(ctx, { resumeProof: false })
    try {
      await ctx.handlers['tools/execute']({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-off', '/w/off') }, async () => 'shared')
      const declare = toolCalls.find((call) => call.name === 'session_start')
      assert.equal('plumb_hook_proof' in declare.arguments, false)
      assert.equal(ctx.logs.filter(([, msg]) => msg.includes('no resume proof')).length, 0)
    } finally {
      await ctx.handlers.dispose?.()
    }
  })
  assert.deepEqual(await readProofLog(log), [], 'the hook was not run')
})

test('per-agent connection: each connection proves its own agent, and the mail fallback keeps the proof', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.sessionStartRefusals = [oldPlumbRefusal()]
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    const wrap = ctx.handlers['tools/execute']
    await wrap({ name: 'mcp__plumb__read_file', arguments: {}, ...conversation('conv-pf-a', '/w/pf') }, async () => 'shared')
    await wrap({
      name: 'mcp__plumb__read_file',
      arguments: {},
      ...conversation('conv-pf-b', '/w/pf', { parentSession: 'conv-pf-a', delegationDepth: 1 })
    }, async () => 'shared')
    const declares = toolCalls.filter((call) => call.name === 'session_start')
    assert.equal(declares.length, 3, 'refused once for mail, retried, then the subagent')
    assert.equal(declares[1].arguments.mail, undefined, 'the retry omits mail')
    for (const call of declares) {
      assert.equal(call.arguments.plumb_agent, call.arguments.session_id, 'the stamp is the declared id')
      assert.equal(call.arguments.plumb_hook_proof, `proof-of-${call.arguments.session_id}`)
    }
    assert.deepEqual(declares.map((call) => call.arguments.session_id), ['dsh-w-pf-conv-pf-a', 'dsh-w-pf-conv-pf-a', 'dsh-w-pf-conv-pf-b'])
  } finally {
    fixtureState.sessionStartRefusals = []
    await ctx.handlers.dispose?.()
  }
})

// -- PLAN-510: one linkage per connection -------------------------------------
//
// The live failure these pin: on 2026-10-11 a DSH agent followed its brief and
// declared its own session_id on a connection whose proven id was the plugin's,
// which replaced the linkage, revoked the resume credential 48 ms after it was
// issued, and marked the connection shared (every state-changing call refused).
// Every reconnect after that resumed by name only, so bound mail stranded.

test('normaliseSessionStart takes over a typed declaration, and leaves a matching one alone', () => {
  assert.equal(normaliseSessionStart({ session_id: 'mine', workspace: '/w' }, 'mine'), null,
    'a declaration that already names this connection’s id is a no-op')
  // A missing or non-object argument set is treated as EMPTY, not as "leave it
  // alone": the id comes from the harness, so the declaration still names it.
  for (const missing of [null, undefined, [], 'session_id=x']) {
    assert.deepEqual(normaliseSessionStart(missing, 'x'), { session_id: 'x' },
      `a ${JSON.stringify(missing)} argument set still declares the harness id`)
  }

  assert.deepEqual(
    normaliseSessionStart({
      session_id: 'typed-by-the-model',
      workspace: '/w/re-pin',
      purpose: 'review',
      detail: 'brief',
      mail: 'preview'
    }, 'dsh-w-conv-a'),
    { session_id: 'dsh-w-conv-a', workspace: '/w/re-pin', purpose: 'review', detail: 'brief', mail: 'preview' },
    'only the id changes: an intentional re-pin, the purpose, the detail and mail survive'
  )

  assert.deepEqual(
    normaliseSessionStart({
      session_id: 'dsh-w-conv-a',
      plumb_agent: 'phantom',
      'dev.plumbkit/logical-agent': 'phantom',
      plumb_hook_proof: 'typed-by-the-model'
    }, 'dsh-w-conv-a'),
    { session_id: 'dsh-w-conv-a' },
    'a typed stamp or proof is dropped even when the id already matches'
  )
})

test('per-agent connection: a model-typed session_id is normalised to the proven id, with the proof', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    let forwarded = false
    await ctx.handlers['tools/execute']({
      name: 'mcp__plumb__session_start',
      arguments: { session_id: 'dsh-plumb-ops-r4t9', workspace: '/w/one', probe: 'model-call' },
      ...conversation('conv-one', '/w/one')
    }, async () => { forwarded = true; return 'shared' })
    assert.equal(forwarded, false, 'the call was served by the agent’s own connection')

    const declares = toolCalls.filter((call) => call.name === 'session_start')
    const mine = declares.find((call) => call.arguments.probe === 'model-call')
    assert.ok(mine, 'the call reached the agent’s own connection')
    assert.equal(mine.arguments.session_id, 'dsh-w-one-conv-one', 'the typed id is replaced by the proven one')
    assert.equal(mine.arguments.workspace, '/w/one', 'the workspace is left as typed')
    assert.equal(mine.arguments.probe, 'model-call', 'nothing else about the call changes')
    assert.equal(mine.arguments.plumb_agent, 'dsh-w-one-conv-one')
    assert.equal(mine.arguments.plumb_hook_proof, 'proof-of-dsh-w-one-conv-one',
      'the per-agent path proves the declaration (the fallback control is below)')

    const reported = ctx.logs.filter(([level, msg]) => level === 'info' && msg.includes('normalised to it'))
    assert.equal(reported.length, 1, 'reported, once')
    assert.match(reported[0][1], /declared session_id dsh-plumb-ops-r4t9/)

    // A second declaration with YET ANOTHER typed id is still one report — the
    // notice is per agent, not per call. (A matching id would not exercise the
    // path at all, which is how this assertion once passed vacuously.)
    await ctx.handlers['tools/execute']({
      name: 'mcp__plumb__session_start',
      arguments: { session_id: 'typed-again', probe: 'second-call' },
      ...conversation('conv-one', '/w/one')
    }, async () => 'shared')
    assert.equal(ctx.logs.filter(([level, msg]) => level === 'info' && msg.includes('normalised to it')).length, 1,
      'reported once per agent, not once per call')
    const second = toolCalls.filter((call) => call.name === 'session_start').find((call) => call.arguments.probe === 'second-call')
    assert.equal(second.arguments.session_id, 'dsh-w-one-conv-one', 'the second typed id is taken over too')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('normaliseDeclarations false: the declaration goes out verbatim, with no proof', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx, { normaliseDeclarations: false })
  try {
    await ctx.handlers['tools/execute']({
      name: 'mcp__plumb__session_start',
      arguments: { session_id: 'typed-by-the-model', workspace: '/w/vb', probe: 'verbatim' },
      ...conversation('conv-vb', '/w/vb')
    }, async () => 'shared')
    const mine = toolCalls.filter((call) => call.name === 'session_start').find((call) => call.arguments.probe === 'verbatim')
    assert.ok(mine, 'the call reached the agent’s own connection')
    assert.equal(mine.arguments.session_id, 'typed-by-the-model', 'the typed id is passed through')
    assert.equal(mine.arguments.workspace, '/w/vb')
    assert.equal('plumb_hook_proof' in mine.arguments, false,
      'a declaration the plugin did not take over is not dressed up with the connection’s proof')
    assert.equal('plumb_agent' in mine.arguments, false)
  } finally {
    await ctx.handlers.dispose?.()
  }
})

test('only session_start is normalised: another call keeps its arguments exactly', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mountPerAgent(ctx)
  try {
    await ctx.handlers['tools/execute']({
      name: 'mcp__plumb__read_file',
      arguments: { path: 'a.go' },
      ...conversation('conv-keep', '/w/keep')
    }, async () => 'shared')
    const read = toolCalls.find((call) => call.name === 'read_file')
    assert.deepEqual(read.arguments, { path: 'a.go' }, 'no session_id is injected into another tool')
  } finally {
    await ctx.handlers.dispose?.()
  }
})

// -- PLAN-516: a call must outlive the idle timer ------------------------------
//
// The idle close used to be armed BEFORE `callTool` and never paused, so it
// closed the client the call was waiting on: a 40 s `check_messages` wait died at
// ~15 s with `MCP error -32000: Connection closed` — the plugin's own idleMs, not
// a client deadline (measured against the real SDK in review) — and so would any
// per-agent call longer than idleMs: a build, a test run, a slow push, a wait.
//
// These pin the fix: an in-flight call is never closed under, and the connection
// still closes idleMs after it settles.

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a per-agent call that outlives idleMs survives, and the connection closes after it settles', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  fixtureState.toolCallDelayMs = 150
  const ctx = stubCtx()
  await mountPerAgent(ctx, { idleMs: 60 })
  try {
    // Watch the whole call, not one instant: an idle close fired at idleMs (60 ms)
    // would otherwise land between two assertions and look like success.
    let closesDuringCall = 0
    const watcher = setInterval(() => {
      if (clients.at(-1)?.closed === true || instances.at(-1)?.closed === true) closesDuringCall += 1
    }, 5)
    const pending = ctx.handlers['tools/execute']({
      name: 'mcp__plumb__read_file',
      arguments: { path: 'slow.go' },
      ...conversation('conv-slow', '/w/slow')
    }, async () => 'shared')

    await sleepMs(110)
    const client = clients.at(-1)
    const transport = instances.at(-1)
    assert.equal(closesDuringCall, 0, 'nothing closed the connection while the call was in flight')
    assert.equal(client.closed, false)
    assert.equal(transport.closed, false)

    await pending // the call completes even though it outlived idleMs
    clearInterval(watcher)
    assert.equal(closesDuringCall, 0, 'still nothing closed it')
    const sent = toolCalls.filter((entry) => entry.name === 'read_file')
    assert.equal(sent.length, 1, 'it went over the agent’s own connection, once')

    await sleepMs(140)
    assert.equal(client.closed, true, 'the connection closes idleMs after the call settles')
    assert.equal(transport.closed, true)
  } finally {
    fixtureState.toolCallDelayMs = 0
    await ctx.handlers.dispose?.()
  }
})
test('fallback: the declaration is normalised but carries no proof', async () => {
  process.env.DSH_HOME = fixtureDshHome
  resetFixture()
  const ctx = stubCtx()
  await mount(ctx) // perAgentConnection: false — the shared serve
  try {
    let forwarded = false
    const exec = {
      name: 'mcp__plumb__session_start',
      arguments: { session_id: 'dsh-plumb-ops-r4t9', workspace: '/w/fb' },
      ...conversation('conv-fb', '/w/fb')
    }
    await ctx.handlers['tools/execute'](exec, async () => { forwarded = true; return 'shared' })
    assert.equal(forwarded, true, 'the shared fallback lets the harness send the call')
    assert.equal(exec.arguments.session_id, 'dsh-w-fb-conv-fb', 'normalised on the fallback too')
    assert.equal(exec.arguments.workspace, '/w/fb')
    assert.equal('plumb_hook_proof' in exec.arguments, false,
      'no proof on a multi-conversation serve: a serve process may link only ONE conversation (serve_resume.go claim())')
    assert.equal('plumb_agent' in exec.arguments, false)

    const declares = toolCalls.filter((call) => call.name === 'session_start')
    for (const call of declares) {
      assert.equal('plumb_hook_proof' in call.arguments, false, 'the plugin’s own fallback declaration is unproved by design')
    }
  } finally {
    await ctx.handlers.dispose?.()
  }
})

// -- SDK root resolution ----------------------------------------------------
//
// The rest of this suite always passes `sdkPath`, so the DEFAULT resolution — the
// one a real DSH install actually uses — was never exercised by any test. That is
// how the plugin came to depend on `~/.dsh/profiles/node_modules`, a tree DSH
// 0.2.0 stopped maintaining: on 2026-10-11 a disk cleanup removed the link's
// target and identity went silently absent, with every test still green.

test('findOwnSdkRoot walks up to an installed copy, and reports null when there is none', () => {
  const root = mkdtempSync(join(tmpdir(), 'plumb-sdk-'))
  const esm = join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
  mkdirSync(join(esm, 'client'), { recursive: true })
  writeFileSync(join(esm, 'client', 'index.js'), '// fixture\n')
  const nested = join(root, 'packages', 'plugin')
  mkdirSync(nested, { recursive: true })

  assert.equal(findOwnSdkRoot(nested), esm, 'a nested plugin directory resolves its ancestor’s install')
  assert.equal(findOwnSdkRoot(root), esm, 'the directory holding node_modules resolves too')

  const bare = mkdtempSync(join(tmpdir(), 'plumb-sdk-bare-'))
  assert.equal(findOwnSdkRoot(bare), null, 'no install anywhere up the tree reports null')

  // A package directory that exists but does not contain the module must not
  // count: the only question that matters is whether the file that gets imported
  // is actually there, which is also why this walks paths instead of resolving
  // the package (an `exports` map could refuse the subpath).
  const hollow = mkdtempSync(join(tmpdir(), 'plumb-sdk-hollow-'))
  mkdirSync(join(hollow, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm'), { recursive: true })
  assert.equal(findOwnSdkRoot(hollow), null, 'an empty package directory does not count as installed')
})

test('defaultSdkRoot prefers the plugin’s own copy and falls back to the profile tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'plumb-home-'))
  const profileEsm = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
  mkdirSync(join(profileEsm, 'client'), { recursive: true })
  writeFileSync(join(profileEsm, 'client', 'index.js'), '// profile\n')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const own = mkdtempSync(join(tmpdir(), 'plumb-own-'))
    const ownEsm = join(own, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
    mkdirSync(join(ownEsm, 'client'), { recursive: true })
    writeFileSync(join(ownEsm, 'client', 'index.js'), '// own\n')
    assert.equal(defaultSdkRoot(own), ownEsm, 'the plugin’s own install wins over a profile copy that also exists')

    const bare = mkdtempSync(join(tmpdir(), 'plumb-bare-'))
    assert.equal(defaultSdkRoot(bare), profileEsm, 'with no own install it falls back to the shared profile tree')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// The capability gap is the state the 2026-10-11 incident was actually in: the
// SDK carrying the stamp could not be imported, so nothing was stamped at all.
// It is reported at WARN, once, naming both paths tried — and each half of that
// sentence is load-bearing. Flipping the level to `info` used to leave every test
// green, and the wording used to claim identity was "stamped rather than owned",
// which is false of a process whose stamp patch never installed. Both are pinned
// here because the message exists to diagnose exactly this failure.
test('the per-agent capability gap warns ONCE, at WARN, naming both paths tried', async () => {
  // A stub client module whose sibling stdio.js does not exist: the client
  // imports and the transport cannot, which is the gap.
  const dir = mkdtempSync(join(tmpdir(), 'plumb-gap-'))
  const stub = join(dir, 'index.js')
  writeFileSync(stub, 'export class Client {}\n')
  process.env.DSH_HOME = join(dir, 'empty-home')

  const ctx = stubCtx()
  // A URL, as the other mounts pass the fixture SDK: the plugin derives the sibling
  // stdio.js with `new URL('./stdio.js', sdkPath)`, which a bare path cannot base.
  await apply(ctx, { sdkPath: pathToFileURL(stub).href, perAgentConnection: true, plumbCommand: fakeHook })
  try {
    const run = (id) => ctx.handlers['tools/execute'](
      { name: 'mcp__plumb__read_file', arguments: { path: 'x.go' }, ...conversation(id, '/w/gap') },
      async () => 'shared'
    )
    await run('conv-gap-1')
    await run('conv-gap-2') // a second agent must not produce a second warning

    const gaps = ctx.logs.filter(([, msg]) => msg.includes('per-agent connections unavailable'))
    assert.equal(gaps.length, 1, `the gap warns exactly once, not per call: ${JSON.stringify(gaps)}`)
    assert.equal(gaps[0][0], 'warn', 'it is a WARNING: the consequence is the PLAN-510 configuration, not a footnote')
    const msg = gaps[0][1]
    assert.match(msg, /SHARED connection/, 'it says which connection the calls take')
    assert.match(msg, /nothing is stamped/,
      'and that NOTHING is stamped — the SDK carrying the stamp is the one that could not be imported')
    assert.match(msg, /profiles\/node_modules\/@modelcontextprotocol\/sdk/, 'it names the profile path it tried')
    // Loose on purpose: whether an own copy exists depends on the ancestors of this
    // checkout (a worktree under an installed tree finds one), and the resolution
    // accepting an ancestor is Node's own behaviour. What must hold either way is
    // that BOTH attempts are reported.
    assert.match(msg, /own copy \(/, 'and the plugin-local copy it tried first')
  } finally {
    await ctx.handlers.dispose?.()
  }
})
