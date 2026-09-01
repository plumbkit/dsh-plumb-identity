// Spike probe for the plumb-identity plugin design. Mounted into a throwaway
// `dsh --profile headless --patch` run, it answers four questions the real
// plugin depends on and logs each answer as one JSON line to config.out:
//
//   1. Does `ctx.on('tools/execute', ...)` see mcp__plumb__* calls, and what
//      does `exec.agent` actually look like at runtime (sessionId? cwd? where)?
//   2. Does an AsyncLocalStorage set around `next()` still read inside the MCP
//      SDK's Client.request — i.e. can we correlate a transport-level request
//      with the DSH agent that caused it?
//   3. Does the stamped request let us capture the plumb Client instance, and
//      can we then issue a proactive session_start through it?
//   4. Does plumb accept the identity (answered by the sqlite/daemon check
//      after the run, not by this file).
//
// Same zero-DSH-imports rule as pauta's observer: the MCP SDK is imported by
// absolute path into DSH's shared profile tree so we patch the very class
// instance dsh-mcp-client uses.

import { openSync, writeSync, closeSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { inspect } from 'node:util'

export const name = 'plumb-spike-probe'

export const inject = ['tools']

const als = new AsyncLocalStorage()

export async function apply (ctx, config) {
  const out = config?.out
  if (typeof out !== 'string' || out.length === 0) throw new Error('plumb-spike-probe: config.out required')
  const fd = openSync(out, 'a', 0o600)
  const log = (record) => {
    try { writeSync(fd, JSON.stringify(record) + '\n') } catch {}
  }
  log({ t: 'boot', config })

  // -- 1. Patch the shared SDK Client class ---------------------------------
  let sdk = null
  try {
    sdk = await import(config?.sdkPath ?? '/Users/gilberto/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')
  } catch (error) {
    log({ t: 'sdk-import-failed', error: String(error) })
  }
  if (sdk?.Client) {
    if (sdk.Client.prototype.__plumbSpikePatched !== true) {
      const orig = sdk.Client.prototype.request
      sdk.Client.prototype.request = function (request, resultSchema, options) {
        try {
          if (request?.method === 'tools/call') {
            const ident = als.getStore()
            if (ident) {
              request.params = request.params ?? {}
              request.params._meta = { ...(request.params._meta ?? {}), 'dev.plumbkit/logical-agent': ident.id }
              captured = new WeakRef(this)
              log({ t: 'stamp', name: request.params.name, id: ident.id })
            }
          }
        } catch (error) {
          log({ t: 'patch-error', error: String(error) })
        }
        return orig.call(this, request, resultSchema, options)
      }
      sdk.Client.prototype.__plumbSpikePatched = true
      log({ t: 'patch-installed' })
    } else {
      log({ t: 'patch-already-present' })
    }
  }

  let captured = null // WeakRef to the plumb Client instance
  const declared = new Map() // sessionId -> identity
  let dumpedAgent = false

  const identityFor = (exec) => {
    const a = exec?.agent
    const sessionId = String(a?.sessionId ?? a?.id ?? 'anon')
    const cwd = String(a?.cwd ?? a?.session?.cwd ?? process.cwd())
    const slug = cwd.split('/').filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48)
    const short = sessionId.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 24) || 'anon'
    return { id: `dsh-${slug}-${short}`, workspace: cwd, sessionId }
  }

  const inspectAgent = (a) => {
    if (a === null || a === undefined) return null
    const shape = { ctor: a.constructor?.name, ownKeys: Object.keys(a).slice(0, 40) }
    for (const k of ['sessionId', 'id', 'name', 'cwd']) {
      if (a[k] !== undefined) shape[k] = String(a[k]).slice(0, 80)
    }
    if (a.session !== undefined && a.session !== null) {
      shape.session = { ctor: a.session.constructor?.name, ownKeys: Object.keys(a.session).slice(0, 40) }
      for (const k of ['sessionId', 'id', 'cwd']) {
        if (a.session[k] !== undefined) shape.session[k] = String(a.session[k]).slice(0, 80)
      }
      const meta = a.session.meta ?? a.session.metadata
      if (meta !== undefined && meta !== null) shape.sessionMeta = inspect(meta, { depth: 1, breakLength: 200 }).slice(0, 600)
    }
    return shape
  }

  // -- 2. The tools/execute wrap --------------------------------------------
  ctx.on('tools/execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !toolName.startsWith(config?.prefix ?? 'mcp__plumb__')) {
      return next()
    }
    try {
      const ident = identityFor(exec)
      log({
        t: 'wrap', name: toolName, ident,
        agent: dumpedAgent ? 'see-first' : inspectAgent(exec?.agent)
      })
      if (!dumpedAgent) {
        dumpedAgent = true
        log({ t: 'agent-inspect', detail: inspect(exec?.agent, { depth: 2, breakLength: 160 }).slice(0, 4000) })
      }

      // Proactive declaration, OUTSIDE the ALS scope so our own request is not stamped.
      if (!declared.has(ident.sessionId) && captured !== null) {
        const client = captured.deref()
        if (client !== undefined) {
          try {
            const types = await import('/Users/gilberto/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js')
            const result = await client.request(
              { method: 'tools/call', params: { name: 'session_start', arguments: { session_id: ident.id, workspace: ident.workspace, purpose: 'dsh-spike', detail: 'brief' } } },
              types.CallToolResultSchema
            )
            declared.set(ident.sessionId, ident)
            log({ t: 'declared', id: ident.id, result: JSON.stringify(result).slice(0, 500) })
          } catch (error) {
            log({ t: 'declare-failed', id: ident.id, error: String(error).slice(0, 400) })
          }
        } else {
          log({ t: 'no-captured-instance' })
        }
      }

      return await als.run(ident, async () => next())
    } catch (error) {
      log({ t: 'wrap-error', name: toolName, error: String(error).slice(0, 400) })
      return next()
    }
  })

  ctx.on('dispose', () => {
    closeSync(fd)
  })
}
