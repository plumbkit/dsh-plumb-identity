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

import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Stable cordis plugin name (loader diagnostics, HMR swap, patch overrides). */
export const name = 'dsh-plumb-identity'

/** The tools service is the only thing this plugin touches on the context. */
export const inject = ['tools']

/** plumb's per-call identity key, from plumb's internal/mcp/meta_keys.go. */
export const identityMetaKey = 'dev.plumbkit/logical-agent'

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
    logEvents: false
  }
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
  return `${process.env.DSH_HOME ?? homedir()}/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm`
}

const moduleSdk = await import(`${defaultSdkRoot()}/client/index.js`).catch(() => null)
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
  const declared = new WeakMap() // Client instance -> Set of sessionIds declared on it
  let plumbClientRef = null // WeakRef to the captured plumb Client
  let restorePatch = null

  // -- Transport stamp ------------------------------------------------------
  // A config-supplied sdkPath is the override hatch for non-standard installs;
  // it re-introduces the apply-time import (and with it the connect race), so
  // the default path — resolved at module load, above — is the supported one.
  const sdk = config?.sdkPath
    ? await import(config.sdkPath).catch(() => null)
    : moduleSdk
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

  // -- Tool waterfall -------------------------------------------------------
  const unwrappedErrors = new Set()
  ctx.on('tools/execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !toolName.startsWith(prefix)) return next()
    try {
      const agentContext = resolveAgentContext(exec)
      if (agentContext === null) {
        if (!unwrappedErrors.has('no-agent')) {
          unwrappedErrors.add('no-agent')
          ctx.logger?.warn?.(`${name}: ${toolName} has no DSH session on exec.agent; passing through unstamped`)
        }
        return next()
      }
      const ident = {
        id: mintIdentity({ prefix: cfg.idPrefix, workspace: agentContext.workspace, sessionId: agentContext.sessionId }),
        workspace: agentContext.workspace
      }

      // Proactive declaration, deliberately OUTSIDE the identity scope: this
      // request must go out unstamped so plumb reads the id from the
      // arguments — the channel its linkage, workspace pin, and orientation
      // packet are built around. Keyed per Client instance because dsh-mcp-client
      // builds a fresh Client on every reconnect generation; a new connection
      // knows no identities and each must re-declare on it.
      const client = plumbClientRef?.deref()
      if (client !== undefined) {
        let seen = declared.get(client)
        if (seen === undefined) {
          seen = new Set()
          declared.set(client, seen)
        }
        if (!seen.has(agentContext.sessionId)) {
          try {
            await client.request({
              method: 'tools/call',
              params: {
                name: 'session_start',
                arguments: {
                  session_id: ident.id,
                  workspace: ident.workspace,
                  purpose: agentContext.isSubagent ? cfg.subagentPurpose : cfg.purpose,
                  detail: cfg.detail
                }
              }
            }, resultSchema ?? { parse: (value) => value })
            seen.add(agentContext.sessionId)
            ctx.logger?.info?.(`${name}: declared ${ident.id} (${ident.workspace}${agentContext.isSubagent ? ', subagent' : ''})`)
          } catch (error) {
            // Fail open: the call proceeds with the _meta stamp only; plumb
            // attributes it but the shard keeps the connection's workspace.
            ctx.logger?.warn?.(`${name}: proactive session_start for ${ident.id} failed: ${String(error).slice(0, 200)}`)
          }
        }
      }

      return await als.run(ident, async () => next())
    } catch (error) {
      const signature = String(error).slice(0, 120)
      if (!unwrappedErrors.has(signature)) {
        unwrappedErrors.add(signature)
        ctx.logger?.warn?.(`${name}: identity wrap failed, passing through unstamped: ${signature}`)
      }
      return next()
    }
  })

  ctx.on('dispose', () => {
    restorePatch?.()
  })
}
