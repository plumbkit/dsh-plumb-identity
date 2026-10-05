// Per-agent plumb identity for the DeepSeek Harness.
//
// # The problem this solves
//
// DSH multiplexes every conversation — and every in-process subagent — over ONE
// long-lived `plumb serve` connection per process, and its MCP client
// (`@deepseek-ai/dsh-mcp-client`) sends no identity: no per-conversation
// session id, no per-call `_meta`. plumb's whole isolation layer (per-agent
// workspace shards, read tracking, mail) is gated on a declared identity, so
// unidentified conversations force-re-pin each other's workspaces — the
// 2026-08-28 pin-displacement incident. The instruction-surface fix
// (`~/.dsh/AGENTS.md`, workspace briefs) covers main conversations that read
// their brief; subagents run with "zero parent context" and are structurally
// anonymous.
//
// # How this plugin declares identity
//
// plumb accepts a logical-agent identity on two channels: `session_start`'s
// `session_id` argument, and a per-call `tools/call` params
// `_meta["dev.plumbkit/logical-agent"]` — the stronger channel, which plumb
// always honours. DSH's client never sends either, so this plugin adds them at
// the only layer that can: the MCP SDK transport, plus DSH's own tool
// waterfall for correlation.
//
//   1. `ctx.on('tools/execute', ...)` sees every tool call with `exec.agent`,
//      the caller — conversation or subagent, each with its own session id.
//      For `mcp__<serverName>__*` calls it mints a stable per-agent plumb id
//      (`dsh-<workspace-slug>-<session-short>`), then runs the rest of the
//      pipeline inside an AsyncLocalStorage scope holding that identity.
//   2. A narrow patch on the shared MCP SDK `Client.prototype.request` stamps
//      `_meta["dev.plumbkit/logical-agent"]` onto `tools/call` requests made
//      inside such a scope. The scope is armed ONLY around plumb tool
//      executions, so a stamped request is by construction a request to the
//      plumb server — no per-instance sniffing needed. The same hook captures
//      the plumb `Client` instance.
//   3. With the captured instance, the plugin issues a proactive
//      `session_start { session_id, workspace, purpose }` for each agent's
//      first plumb call — outside the identity scope, so the id travels in the
//      arguments where plumb's linkage records it and the agent's shard pins
//      ITS OWN workspace. This is what makes multi-workspace multiplexing on
//      one connection safe, including for subagents that never read any brief.
//
// Every step fails open: if the SDK module moves, the patch refuses to
// reinstall, or plumb refuses a declaration, the call proceeds unstamped and
// the AGENTS.md instruction surface remains the fallback. A tool call must
// never break because its observer could not describe itself.
//
// # The stronger fix: one `plumb serve` per agent (`perAgentConnection`)
//
// Stamping is mitigation. It makes a SHARED connection attributable, and it
// depends on plumb's identity layer being present, correct and reached — the
// chain that silently broke on 2026-10-01 when `dsh-mcp-client` moved to
// `@modelcontextprotocol/client@2.0.0` and left the patch on a class nothing
// instantiated. Every other harness on this machine gives each client process
// its own `plumb serve`; DSH is the outlier because it multiplexes every
// conversation and in-process subagent over ONE connection per process.
//
// DSH's own scope layer is built for the alternative — the MCP client's
// `apply` "reserves the serverName inside the current registration scope", and
// "independent Agent scopes may reuse the same namespace because their tools
// and transports are isolated" — but nothing MOUNTS an MCP server into an
// Agent scope: a preset's plugins are "eagerly activated once and shared by
// their selecting Agents". The capability exists; configuration cannot reach
// it.
//
// So this plugin reaches it: for a plumb call from an agent it has a session
// for, it spawns its OWN `plumb serve` child, declares that agent on it, and
// dispatches the call over that connection instead of the shared one. The
// connection IS the identity — no `_meta` stamping, no shared-connection gate,
// no pin collisions, no cross-agent writes, and nothing to keep in sync with
// plumb's identity internals.
//
// Two rules keep it strictly better than the shared path:
//
//   * It only ever falls back BEFORE dispatch — an unreachable per-agent
//     connection, or a tool name the per-agent server does not list, hands the
//     call to the shared client exactly as before. A call that has been sent is
//     never retried on another connection, because plumb's writes are not
//     idempotent and a "retry" could apply them twice.
//   * The shared connection keeps doing what it is good at: tool discovery
//     (the model-facing schemas) and resource reads. Only EXECUTION moves.

import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Stable cordis plugin name (loader diagnostics, HMR swap, patch overrides). */
export const name = 'dsh-plumb-identity'

/** Reported to plumb in the MCP client handshake; informational only. */
let pluginVersion = '0.0.0'
try {
  const pkg = await import(new URL('./package.json', import.meta.url).href, { with: { type: 'json' } })
  pluginVersion = pkg.default?.version ?? pluginVersion
} catch {
  // The version is informational; a package.json that cannot be read must not
  // stop the plugin from loading.
}

/** The tools service is the only thing this plugin touches on the context. */
export const inject = ['tools']

/**
 * Diagnostic channel for the per-agent connection lifecycle, off unless
 * `PLUMB_IDENTITY_DEBUG` is set. It writes to stderr rather than the plugin
 * logger because the interesting failures happen before a call can be
 * attributed to an agent, and a host that swallows info logs would hide them.
 */
function debug (...args) {
  if (process.env.PLUMB_IDENTITY_DEBUG) console.error('[dsh-plumb-identity]', ...args)
}

/** plumb's per-call identity key, from plumb's internal/mcp/meta_keys.go. */
export const identityMetaKey = 'dev.plumbkit/logical-agent'

/**
 * plumb's machine-readable failure envelope, from plumb's internal/mcp/meta_keys.go.
 * A refused declaration carries it on the tool RESULT's _meta — the envelope,
 * not the error text, is what this plugin branches on.
 */
export const toolErrorMetaKey = 'dev.plumbkit/error'

/** Defaults; every field is overridable from the patch row's `config`. */
export function defaultConfig () {
  return {
    serverName: 'plumb',
    idPrefix: 'dsh',
    purpose: 'dsh',
    subagentPurpose: 'dsh-subagent',
    detail: 'brief',
    excludeEnv: ['PAUTA_RUN_ID'],
    connectMarker: 'plumb',
    logEvents: false,
    // Give each agent its own `plumb serve` and dispatch its plumb calls over
    // it. Set false to return to stamping identity onto the shared connection,
    // which is what this plugin did before per-agent connections existed.
    perAgentConnection: true,
    // Empty means: $PLUMB_BIN, else `plumb` on PATH. Set it when the binary is
    // somewhere neither reaches.
    plumbCommand: '',
    plumbArgs: ['serve'],
    // Bounded so a long-lived process cannot accumulate transports without
    // limit. The least recently used connection is closed when it is exceeded.
    maxConnections: 16,
    // Close a connection after this long with no call on it (0 keeps it for the
    // life of the process). A plugin inside someone else's host must not hold
    // resources the host cannot reclaim: DSH's headless path never disposes
    // plugins, so a connection that is merely idle outlives the run and the
    // process then never exits. Reconnecting is cheap and self-healing —
    // `connectionFor` re-declares the agent and its workspace on every connect
    // — so an idle close costs one spawn, not correctness.
    idleMs: 15_000
  }
}

/**
 * The command that starts a per-agent plumb proxy: an explicit config value
 * wins, then $PLUMB_BIN (what the e2e harness sets), then PATH.
 */
export function resolvePlumbCommand (config, env) {
  const configured = config?.plumbCommand
  if (typeof configured === 'string' && configured.length > 0) return configured
  const fromEnv = env?.PLUMB_BIN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return 'plumb'
}

/**
 * The child environment for a per-agent proxy: the ambient one, minus entries
 * with no value. plumb is a local trusted binary and needs what a normal shell
 * gives it (PATH to resolve itself, HOME/XDG for its daemon state), so unlike a
 * remote MCP server this is a pass-through rather than a scrub.
 */
export function childEnv (env) {
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Project MCP result content into the model-facing text the bridge would
 * render. Mirrors `extractText` in `@deepseek-ai/dsh-mcp-client`: text runs are
 * joined by newlines, and a block that is not text contributes a one-line
 * diagnostic rather than disappearing.
 */
export function mcpContentText (content, toolName) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks
    .map((block) => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      const kind = typeof block?.type === 'string' ? block.type : 'unknown'
      return `[${toolName}: ${kind} content is not rendered as text]`
    })
    .filter((part) => part.length > 0)
  return text.join('\n')
}

/**
 * Resolve the caller identity from one tool execution, or null when the
 * caller carries no DSH session (then the call passes through unstamped).
 *
 * Field locations verified against `@deepseek-ai/dsh@0.1.1-rc.2`: the agent
 * is a ReactLoopAgent whose `id` is the conversation/session UUID and whose
 * `session.header` carries the validated `cwd` and, for subagents, the
 * `parentSession`/`delegationDepth` lineage.
 */
export function resolveAgentContext (exec) {
  const agent = exec?.agent
  if (agent === null || agent === undefined) return null
  const header = agent.session?.header ?? {}
  const sessionId = agent.id ?? header.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const workspace = header.cwd ?? agent.cwd ?? process.cwd()
  const isSubagent = (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) ||
    typeof header.parentSession === 'string'
  return { sessionId, workspace, isSubagent }
}

/**
 * Mint the stable plumb external id for one DSH session: deterministic in
 * (workspace, sessionId) so a resumed conversation inherits its plumb session
 * name, and restricted to plumb's friendly charset. The workspace slug keeps
 * same-machine sessions from different projects legible in `plumb sessions`.
 */
export function mintIdentity ({ prefix, workspace, sessionId }) {
  const slug = workspace
    .split('/')
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace'
  const short = sessionId.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'anon'
  return `${prefix}-${slug}-${short}`
}

/** True when an excluded environment variable is set — pauta headless runs declare their own linkage. */
export function shouldSkip (config, env) {
  return (config.excludeEnv ?? []).some((key) => typeof env?.[key] === 'string' && env[key].length > 0)
}

// -- SDK, imported at module load -----------------------------------------
//
// The SDK must be imported by absolute path so the patched class is the very
// instance `dsh-mcp-client` uses; the default path assumes the standard shared
// profile tree, overridable per-apply via `sdkPath`. The import runs as a
// top-level await, deliberately: dsh-mcp-client starts connecting the moment
// its own apply runs, so identity patching has to be synchronous by the time
// cordis calls this plugin's apply — an await inside apply would lose that
// race and the connect-time capture below would never see the connection.
// Keep this plugin's patch row ABOVE the mcp-client rows so the loader gets
// here first. Failure to import is survivable (fail open, stamp nothing), so
// the awaited imports swallow their errors.

function defaultSdkRoot () {
  // Match dsh's own home resolution: an explicit $DSH_HOME IS the dsh home
  // root; only the default gets the `.dsh` suffix (`~/.dsh`). Appending `.dsh`
  // unconditionally made the SDK unimportable — and identity silently absent —
  // whenever DSH_HOME pointed at a custom home.
  const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
  return `${home}/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm`
}

const moduleSdk = await import(`${defaultSdkRoot()}/client/index.js`).catch(() => null)
const moduleTransport = await import(`${defaultSdkRoot()}/client/stdio.js`).catch(() => null)
const moduleSchema = await import(`${defaultSdkRoot()}/types.js`)
  .then((m) => m.CallToolResultSchema ?? null)
  .catch(() => null)

/**
 * Mount the plugin. `config` (all optional, see defaultConfig) arrives through
 * the patch row.
 *
 * Async by signature only: on the default sdkPath the SDK is already in hand
 * (module top-level import above), so the patches below install synchronously
 * within the apply call — no await precedes them. The sdkPath override is the
 * exception (test fixture, non-standard layout): it imports at apply time and
 * re-opens the connect race described above.
 */
export async function apply (ctx, config) {
  const cfg = { ...defaultConfig(), ...(config ?? {}) }
  const prefix = `mcp__${cfg.serverName}__`

  if (shouldSkip(cfg, process.env)) {
    ctx.logger?.info?.(`${name}: excluded by environment (${(cfg.excludeEnv ?? []).filter((k) => process.env[k]).join(', ')}); pauta runs declare their own plumb linkage`)
    return
  }

  const als = new AsyncLocalStorage()
  // Client instance -> Map<sessionId, Promise<boolean>>. The whole DECLARATION
  // is memoised, not merely its success: two simultaneous first calls from one
  // agent must not issue two session_starts, and a failed one must stay
  // retryable on a later call without repeating on every call.
  const declaring = new WeakMap()
  // Client instance -> Set<sessionId> already reported, so a failure that keeps
  // recurring does not become a warning on every plumb call.
  const declarationNotified = new WeakMap()
  let plumbClientRef = null // WeakRef to the captured plumb Client
  let restorePatch = null
  // Proof of DELIVERY, not of intent. The patch installing proves nothing: it
  // can land on a class the running dsh-mcp-client never instantiates (a
  // different @modelcontextprotocol package, or a different major of it), in
  // which case every call travels unstamped while the plugin reports success.
  // Counting routed calls against applied stamps is the only observation that
  // distinguishes the two.
  let plumbCallsRouted = 0
  let stampsApplied = 0
  let unstampedReported = false

  // -- Transport stamp ------------------------------------------------------
  // A config-supplied sdkPath is the override hatch for non-standard installs;
  // it re-introduces the apply-time import (and with it the connect race), so
  // the default path — resolved at module load, above — is the supported one.
  // Named in the unstamped-call warning below: the path is the whole diagnosis
  // when the patched class turns out not to be the one in use.
  const sdkSource = config?.sdkPath ?? `${defaultSdkRoot()}/client/index.js`
  const sdk = config?.sdkPath
    ? await import(config.sdkPath).catch(() => null)
    : moduleSdk
  const transportModule = config?.sdkPath
    ? await import(new URL('./stdio.js', config.sdkPath).href).catch(() => null)
    : moduleTransport
  const resultSchema = config?.sdkPath
    ? null
    : moduleSchema
  if (sdk === null) {
    ctx.logger?.warn?.(`${name}: MCP SDK not importable; falling back to the AGENTS.md instruction surface — calls will go out unstamped`)
  }
  if (sdk?.Client?.prototype?.request !== undefined) {
    const proto = sdk.Client.prototype
    if (proto.__plumbIdentityPatched === true) {
      ctx.logger?.warn?.(`${name}: Client.request already patched; leaving the existing patch alone`)
    } else {
      const original = proto.request
      // On the real SDK `request` is inherited from Protocol.prototype and the
      // patch shadows it with an own property; a fixture (or a future SDK)
      // may declare it directly on Client.prototype. Restore accordingly.
      const shadowedOwn = Object.prototype.hasOwnProperty.call(proto, 'request')
      proto.request = function patchedRequest (request, resultSchema, options) {
        try {
          // Capture the plumb client the moment its connection names itself —
          // the stdio transport's server params name the `plumb serve` command.
          // The SDK syncs tools right after connecting, so this fires long
          // before any agent exists and no boot-order race is involved. The
          // stamp branch below re-captures per call, which keeps the reference
          // fresh across the client's reconnect generations even if a future
          // SDK hides the transport.
          if (plumbClientRef === null && this.transport !== undefined && this.transport !== null) {
            const params = this.transport._serverParams
            const command = String(params?.command ?? '')
            if (command.includes(cfg.connectMarker) && (params?.args ?? []).includes('serve')) {
              plumbClientRef = new WeakRef(this)
              if (cfg.logEvents) ctx.logger?.info?.(`${name}: captured plumb client (${command})`)
            }
          }
          if (request?.method === 'tools/call') {
            const ident = als.getStore()
            if (ident !== undefined) {
              request.params = request.params ?? {}
              request.params._meta = { ...(request.params._meta ?? {}), [identityMetaKey]: ident.id }
              plumbClientRef = new WeakRef(this)
              stampsApplied += 1
              if (cfg.logEvents) ctx.logger?.info?.(`${name}: stamped ${request.params.name} as ${ident.id}`)
            }
          }
        } catch {
          // A stamping problem must never become a transport problem.
        }
        return original.call(this, request, resultSchema, options)
      }
      proto.__plumbIdentityPatched = true
      restorePatch = () => {
        try {
          if (shadowedOwn) proto.request = original
          else delete proto.request
          delete proto.__plumbIdentityPatched
        } catch {
          // Process is tearing down anyway.
        }
      }
    }
  }

  // -- Declaration -----------------------------------------------------------
  //
  // A refused declaration is NOT a transport failure. plumb answers a refused
  // session_start with an ordinary tools/call result whose isError is true, so
  // a try/catch around the request sees SUCCESS and records the agent as
  // declared — which is what this code did until 2026-09-16, silently leaving
  // the agent resolving relative paths, and git's default repository, against
  // whichever workspace the CONNECTION was pinned to (another conversation's).
  //
  // The retry policy comes from plumb's own scope, never from the sentence:
  //   scope 'agent'      — force: true moves only THIS agent's shard, so an
  //                        automatic retry is safe and clears the refusal.
  //   scope 'connection' — force: true moves the pin every agent on this
  //                        connection resolves against, which may have been
  //                        restored for another conversation. Never forced
  //                        automatically; surfaced instead.

  /** Records the first report for one (client, agent); false for every repeat. */
  function noteDeclarationOnce (client, sessionId) {
    let seen = declarationNotified.get(client)
    if (seen === undefined) {
      seen = new Set()
      declarationNotified.set(client, seen)
    }
    if (seen.has(sessionId)) return false
    seen.add(sessionId)
    return true
  }

  /** One declaration request, optionally forcing it. Never stamped (see below). */
  function sendDeclaration (client, agentContext, ident, resultSchema, force) {
    const args = {
      session_id: ident.id,
      workspace: ident.workspace,
      purpose: agentContext.isSubagent ? cfg.subagentPurpose : cfg.purpose,
      detail: cfg.detail
    }
    if (force) args.force = true
    return client.request({
      method: 'tools/call',
      params: { name: 'session_start', arguments: args }
    }, resultSchema ?? { parse: (value) => value })
  }

  /**
   * Declare one agent on one client. Deliberately OUTSIDE the identity scope:
   * the request must travel unstamped so plumb reads the id from the
   * ARGUMENTS — the channel its linkage, workspace pin and orientation packet
   * are built around.
   *
   * Returns 'declared', 'refused' (plumb said no — do not retry blindly) or
   * 'unreachable' (the request itself failed — a later call may retry).
   */
  async function declareOn (client, agentContext, ident, resultSchema) {
    let result
    try {
      result = await sendDeclaration(client, agentContext, ident, resultSchema, false)
    } catch (error) {
      if (noteDeclarationOnce(client, agentContext.sessionId)) {
        ctx.logger?.warn?.(`${name}: session_start for ${ident.id} could not be sent (${String(error).slice(0, 160)}); the call proceeds with the _meta stamp only and a later call will retry`)
      }
      return 'unreachable'
    }
    if (result?.isError !== true) {
      ctx.logger?.info?.(`${name}: declared ${ident.id} (${ident.workspace}${agentContext.isSubagent ? ', subagent' : ''})`)
      return 'declared'
    }

    const scope = result?._meta?.[toolErrorMetaKey]?.details?.scope
    if (scope === 'agent') {
      // Safe by construction: this moves only the declaring agent's own shard.
      try {
        const forced = await sendDeclaration(client, agentContext, ident, resultSchema, true)
        if (forced?.isError !== true) {
          ctx.logger?.info?.(`${name}: declared ${ident.id} after a per-agent re-pin refusal (force)`)
          return 'declared'
        }
      } catch {
        // Report it below with what is known; the refusal is the fact that matters.
      }
    }
    if (noteDeclarationOnce(client, agentContext.sessionId)) {
      const why = scope === 'connection'
        ? 'the connection pin belongs to another workspace, and forcing it would move the pin every agent on this connection resolves against'
        : scope === 'agent'
          ? 'the forced per-agent retry was refused too'
          : 'no machine-readable scope was reported'
      ctx.logger?.warn?.(`${name}: plumb refused the declaration for ${ident.id} (${ident.workspace}) — ${why}. Until it is declared, workspace-dependent calls can resolve against another project: re-issue session_start with workspace + session_id + force: true, and prefer absolute paths meanwhile`)
    }
    return 'refused'
  }

  /**
   * The memoised declaration for one (client, agent). Concurrent first calls
   * share one promise, so two simultaneous calls cannot issue two
   * declarations. A REFUSAL is kept (it needs a human or the model to act, and
   * retrying every call would only add a round-trip); a request that never
   * reached plumb is evicted so a later call retries it.
   */
  function declarationFor (client, agentContext, ident, resultSchema) {
    let byId = declaring.get(client)
    if (byId === undefined) {
      byId = new Map()
      declaring.set(client, byId)
    }
    let pending = byId.get(agentContext.sessionId)
    if (pending === undefined) {
      pending = declareOn(client, agentContext, ident, resultSchema).then((outcome) => {
        if (outcome === 'unreachable') byId.delete(agentContext.sessionId)
        return outcome === 'declared'
      })
      byId.set(agentContext.sessionId, pending)
    }
    return pending
  }

  // -- Per-agent connections ------------------------------------------------
  //
  // One `plumb serve` child per agent, opened lazily on that agent's first
  // plumb call and declared on the spot, then reused for the life of the
  // process. Keyed by DSH session id, which is what identifies a conversation
  // or an in-process subagent.
  //
  // This is the structural fix: the connection carries the identity, so there
  // is nothing to stamp onto a shared one and no way for two agents to be
  // confused for each other.

  const connections = new Map() // sessionId -> { promise, client, transport, toolNames, lastUsed }
  const connectionFaults = new Set()
  let connectionsClosed = false
  let capabilityNoted = false

  /**
   * The stdio transport and client classes this mode needs, or null when the
   * SDK they live in could not be imported. That is a capability gap rather
   * than a fault — the plugin simply stays on the shared connection — so it is
   * noted once at info level and never as a warning.
   */
  function perAgentClasses () {
    const Transport = transportModule?.StdioClientTransport
    if (Transport === undefined || Transport === null) return null
    if (sdk?.Client === undefined || sdk.Client === null) return null
    return { Transport, Client: sdk.Client }
  }

  function noteCapabilityGap () {
    if (capabilityNoted) return
    capabilityNoted = true
    ctx.logger?.info?.(`${name}: per-agent connections unavailable (MCP client/stdio transport not importable); plumb calls use the shared connection`)
  }

  function closeEntry (entry) {
    // Best effort: a failing close must not mask whatever prompted it.
    if (entry?.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    try { entry?.client?.close?.() } catch { /* teardown */ }
    try { entry?.transport?.close?.() } catch { /* teardown */ }
  }

  /**
   * Mark a connection as just used and arm its idle close. The timer is
   * unref'd, so it can never be the reason the host process stays alive — that
   * would defeat its purpose.
   */
  function touch (key, entry) {
    entry.lastUsed = Date.now()
    if (!(cfg.idleMs > 0)) return
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (connections.get(key) !== entry) return
      connections.delete(key)
      closeEntry(entry)
      debug('idle-close', key)
    }, cfg.idleMs)
    entry.idleTimer.unref?.()
  }

  /** Keep the registry bounded; close the least recently used excess. */
  function evictConnections () {
    if (connections.size <= cfg.maxConnections) return
    const candidates = [...connections.entries()]
      .filter(([, entry]) => entry.client !== undefined)
      .sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0))
    while (connections.size > cfg.maxConnections && candidates.length > 0) {
      const [key, entry] = candidates.shift()
      connections.delete(key)
      closeEntry(entry)
      if (cfg.logEvents) ctx.logger?.info?.(`${name}: closed the least recently used plumb connection (${key})`)
    }
  }

  /** Report a connection fault once per distinct signature, not once per call. */
  function noteConnectionFault (key, error) {
    const signature = `${key}: ${String(error).slice(0, 120)}`
    if (connectionFaults.has(signature)) return
    connectionFaults.add(signature)
    ctx.logger?.warn?.(`${name}: no per-agent plumb connection for ${key} (${signature}); this call uses the shared one`)
  }

  /**
   * The agent's own plumb connection, opened on first use and shared by that
   * agent's concurrent calls. Rejects when it cannot be opened at all — the
   * caller then falls back to the shared connection, BEFORE anything is sent.
   */
  function connectionFor (agentContext, ident, classes) {
    const key = agentContext.sessionId
    const existing = connections.get(key)
    if (existing !== undefined) return existing.promise

    const entry = { lastUsed: Date.now() }
    entry.promise = (async () => {
      if (classes === null || classes === undefined) throw new Error('per-agent connection classes are unavailable')
      debug('connecting', key, 'cwd=' + agentContext.workspace, 'command=' + resolvePlumbCommand(cfg, process.env))
      const { Transport, Client } = classes

      const transport = new Transport({
        command: resolvePlumbCommand(cfg, process.env),
        args: cfg.plumbArgs,
        cwd: agentContext.workspace,
        env: childEnv(process.env),
        // Deliberately NOT the SDK default. Unset `stderr` means 'inherit', and
        // an inherited stderr is a descriptor the HOST's own parent may be
        // waiting to drain: a run that finished cleanly then looks like a hang,
        // because this child outlives the turn that started it. Piped here (and
        // drained below) so the child can never hold a descriptor the host
        // cares about, while its output stays available when events are logged.
        stderr: 'pipe'
      })
      // Drain unconditionally: an unread pipe would apply backpressure to the
      // child and eventually stall it.
      transport.stderr?.on?.('data', (chunk) => {
        if (cfg.logEvents) ctx.logger?.info?.(`${name}: ${String(chunk).trimEnd()}`)
      })
      const client = new Client({ name, version: pluginVersion }, { capabilities: {} })
      await client.connect(transport)
      debug('connected', key)
      entry.transport = transport
      entry.client = client

      // What THIS connection advertises. The routing guard refuses to send a
      // name it does not list, so a schema change on the shared connection can
      // never be dispatched into a connection that cannot serve it.
      const listed = await client.listTools?.({})
      entry.toolNames = new Set((listed?.tools ?? []).map((tool) => tool.name))
      debug('advertised', key, entry.toolNames.size + ' tools')

      // Declare this agent ON ITS OWN CONNECTION. Nothing else shares it, so
      // the id and the workspace pin cannot land on another agent's shard.
      const args = {
        session_id: ident.id,
        workspace: ident.workspace,
        purpose: agentContext.isSubagent ? cfg.subagentPurpose : cfg.purpose,
        detail: cfg.detail
      }
      try {
        await client.callTool({ name: 'session_start', arguments: args }, resultSchema ?? undefined)
      } catch (error) {
        // Not fatal: the connection is still this agent's own, so the worst
        // case is an undeclared shard, which the AGENTS.md surface covers.
        ctx.logger?.warn?.(`${name}: session_start on ${ident.id}'s own connection failed (${String(error).slice(0, 120)}); the connection is still private to this agent`)
      }

      touch(key, entry)
      debug('declared', ident.id)
      if (cfg.logEvents) ctx.logger?.info?.(`${name}: opened a plumb connection for ${ident.id} (${entry.toolNames.size} tools)`)
      return entry
    })()

    connections.set(key, entry)
    evictConnections()
    // Drop a failed attempt so the agent's next call can retry it.
    entry.promise.catch(() => { connections.delete(key) })
    return entry.promise
  }

  /**
   * Dispatch one plumb call over the agent's own connection.
   *
   * Returns the normalized result for the waterfall, or null to fall back to
   * the shared client. The fallback happens ONLY before dispatch — no
   * connection, or a tool name this server does not advertise. A call that has
   * already been sent is never re-sent elsewhere: plumb's writes are not
   * idempotent, so a retry could apply one twice. That is why an error from the
   * call itself propagates instead of falling back.
   */
  async function routeOverOwnConnection (exec, toolName, agentContext, ident) {
    const classes = perAgentClasses()
    if (classes === null) {
      noteCapabilityGap()
      return null
    }

    const rawName = toolName.slice(prefix.length)
    debug('route', rawName, 'agent=' + agentContext.sessionId)
    let entry
    try {
      entry = await connectionFor(agentContext, ident, classes)
    } catch (error) {
      debug('route: connection failed', rawName, String(error))
      noteConnectionFault(agentContext.sessionId, error)
      return null
    }
    if (!entry.toolNames.has(rawName)) {
      if (cfg.logEvents) ctx.logger?.info?.(`${name}: ${rawName} is not advertised by the per-agent connection; using the shared one`)
      return null
    }

    touch(agentContext.sessionId, entry)
    debug('dispatch', rawName, 'over client for', agentContext.sessionId)
    const call = await entry.client.callTool(
      { name: rawName, arguments: exec.arguments ?? {} },
      resultSchema ?? undefined,
      exec.signal === undefined ? undefined : { signal: exec.signal }
    )

    debug('dispatched', rawName)
    const content = Array.isArray(call?.content) ? call.content : []
    if (call?.isError === true) throw new Error(mcpContentText(content, rawName))
    // The bridge's canonical success value, so downstream consumers (retention,
    // PTC callers) see the same shape they would from the shared connection.
    const value = {
      content,
      ...(call?.structuredContent !== undefined ? { structuredContent: call.structuredContent } : {})
    }
    return { isError: false, value, content: [{ type: 'text', text: mcpContentText(content, rawName) }] }
  }

  // -- Tool waterfall -------------------------------------------------------
  const unwrappedErrors = new Set()

  /** Warn once per distinct pre-dispatch failure, never once per call. */
  function noteUnwrapped (error) {
    const signature = String(error).slice(0, 120)
    if (unwrappedErrors.has(signature)) return
    unwrappedErrors.add(signature)
    ctx.logger?.warn?.(`${name}: identity wrap failed, passing through unstamped: ${signature}`)
  }

  /**
   * Resolve the caller and its identity, or null when the caller carries no DSH
   * session (the call then passes through untouched, reported once).
   */
  function prepareCall (exec, toolName) {
    const agentContext = resolveAgentContext(exec)
    if (agentContext === null) {
      if (!unwrappedErrors.has('no-agent')) {
        unwrappedErrors.add('no-agent')
        ctx.logger?.warn?.(`${name}: ${toolName} has no DSH session on exec.agent; passing through unstamped`)
      }
      return null
    }
    return {
      agentContext,
      ident: {
        id: mintIdentity({ prefix: cfg.idPrefix, workspace: agentContext.workspace, sessionId: agentContext.sessionId }),
        workspace: agentContext.workspace
      }
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !toolName.startsWith(prefix)) return next()

    // Only the PRE-DISPATCH phase is guarded. Everything it can fail at —
    // resolving the caller, minting the identity — leaves the call unsent, so
    // falling back to the shared client is safe and is what it did before this
    // mode existed.
    //
    // Dispatch is deliberately NOT guarded: once a call has been sent, an error
    // must reach the harness rather than be retried on the other connection,
    // because plumb's writes are not idempotent and a "fallback" would be a
    // second execution of the same mutation.
    let prepared
    try {
      prepared = prepareCall(exec, toolName)
    } catch (error) {
      noteUnwrapped(error)
      return next()
    }
    if (prepared === null) return next()
    const { agentContext, ident } = prepared

    // Prefer the agent's OWN connection: the connection is the identity, so
    // nothing has to be stamped onto a shared one. Falls back before dispatch,
    // never after — routeOverOwnConnection returns null only when it has sent
    // nothing.
    if (cfg.perAgentConnection === true && !connectionsClosed) {
      const routed = await routeOverOwnConnection(exec, toolName, agentContext, ident)
      if (routed !== null) return routed
    }

    // -- Shared-connection fallback (the pre-per-agent behaviour) -------------
    //
    // Proactive declaration, deliberately OUTSIDE the identity scope: this
    // request must go out unstamped so plumb reads the id from the arguments —
    // the channel its linkage, workspace pin, and orientation packet are built
    // around. Keyed per Client instance because dsh-mcp-client builds a fresh
    // Client on every reconnect generation; a new connection knows no
    // identities and each must re-declare on it.
    const client = plumbClientRef?.deref()
    if (client !== undefined) {
      try {
        await declarationFor(client, agentContext, ident, resultSchema)
      } catch (error) {
        // Advisory: the call itself still proceeds, exactly once.
        noteUnwrapped(error)
      }
    }

    plumbCallsRouted += 1
    const outcome = await als.run(ident, async () => next())

    // A plumb call that completed without a single stamp means the transport
    // patch is NOT on the request path of the client dsh-mcp-client actually
    // uses. The usual cause is a package split: dsh-mcp-client stopped
    // importing `@modelcontextprotocol/sdk` and moved to another
    // @modelcontextprotocol package, or to a new major of it, so the class
    // patched above is never instantiated. Nothing else here can see that —
    // the import succeeded, the patch installed, and the calls simply travel
    // without identity. Reported once per apply, because it is a property of
    // the install rather than of the call.
    if (stampsApplied === 0 && !unstampedReported) {
      unstampedReported = true
      ctx.logger?.warn?.(`${name}: routed ${plumbCallsRouted} plumb call(s) with nothing stamped — the MCP client patch at ${sdkSource} is not on the running client's request path, so plumb cannot attribute these calls and refuses the state-changing ones. Check that dsh-mcp-client imports the same @modelcontextprotocol package (and major) this plugin patched.`)
    }

    return outcome
  })

  ctx.on('dispose', () => {
    debug('dispose: closing', connections.size, 'per-agent connection(s)')
    connectionsClosed = true
    for (const entry of connections.values()) closeEntry(entry)
    connections.clear()
    restorePatch?.()
  })
}
