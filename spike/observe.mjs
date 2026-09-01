// Diagnostic observer: logs every tools/execute waterfall dispatch — tool
// name plus the calling agent's session id and delegation depth — to a file.
// Pure listener: no SDK patch, no state. Answers one question: does the
// app-context tools/execute waterfall see subagent tool calls?

import { openSync, writeSync, closeSync } from 'node:fs'

export const name = 'plumb-spike-observe'

export const inject = ['tools']

export function apply (ctx, config) {
  const out = config?.out
  if (typeof out !== 'string' || out.length === 0) throw new Error('plumb-spike-observe: config.out required')
  const fd = openSync(out, 'a', 0o600)
  const log = (record) => {
    try { writeSync(fd, JSON.stringify(record) + '\n') } catch {}
  }
  log({ t: 'boot' })

  ctx.on('tools/execute', async (exec, next) => {
    const a = exec?.agent
    const header = a?.session?.header ?? {}
    log({
      t: 'call',
      name: exec?.name,
      agentId: a?.id ?? header.id,
      depth: header.delegationDepth,
      parent: header.parentSession,
      scopeCtor: a?.scope?.ctx?.constructor?.name
    })
    return next()
  })

  ctx.on('subagent/start', (...args) => log({ t: 'subagent/start', args: args.length }))
  ctx.on('dispose', () => closeSync(fd))
}
