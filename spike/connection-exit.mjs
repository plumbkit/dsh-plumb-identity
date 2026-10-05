// Does a per-agent connection let a Node process exit on its own?
//
// The e2e run showed DSH printing its final answer and then never exiting once
// the plugin opened its own `plumb serve` — the harness had to SIGTERM it at
// 180 s. This isolates that question from DSH entirely: connect with the real
// SDK, optionally close, optionally unref, and see whether the process ends.
//
// Usage: node spike/connection-exit.mjs <mode>
//   modes: open | close | unref | unref-close
// An isolated HOME/XDG keeps this away from the developer's own daemon.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SDK_ROOT = process.env.SDK_ROOT ?? `${process.env.HOME}/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm`
const MODE = process.argv[2] ?? 'close'

const root = mkdtempSync('/tmp/plumb-exit-spike-')
const home = join(root, 'home')
mkdirSync(home, { recursive: true })

const { Client } = await import(`${SDK_ROOT}/client/index.js`)
const { StdioClientTransport } = await import(`${SDK_ROOT}/client/stdio.js`)

const transport = new StdioClientTransport({
  command: process.env.PLUMB_BIN ?? 'plumb',
  args: ['serve'],
  env: {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state')
  }
})

const client = new Client({ name: 'exit-spike', version: '0' }, { capabilities: {} })
await client.connect(transport)
const listed = await client.listTools()
console.log(`[${MODE}] connected, ${listed.tools.length} tools`)

const child = transport._process ?? transport.process
console.log(`[${MODE}] child pid ${child?.pid ?? 'unknown'}`)

if (MODE === 'close' || MODE === 'unref-close') {
  await client.close()
  console.log(`[${MODE}] client.close() returned`)
}

if (MODE === 'unref' || MODE === 'unref-close') {
  console.log(`[${MODE}] unref: child=${typeof child?.unref} stdin=${typeof child?.stdin?.unref} stdout=${typeof child?.stdout?.unref}`)
  child?.unref?.()
  child?.stdin?.unref?.()
  child?.stdout?.unref?.()
  child?.stderr?.unref?.()
}

console.log(`[${MODE}] end of script — if you are reading this after a timeout, the process hung`)

// Clean up only if we are about to exit normally.
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})
