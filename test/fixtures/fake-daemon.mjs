// A stand-in for `plumb daemon` in test/isolated-daemon.test.mjs: it binds
// <runtimeDir>/plumb.sock and writes <runtimeDir>/plumb.pid, the two things the
// e2e teardown looks for, then prints "ready". Modes:
//   graceful    on SIGTERM close the socket, remove the pidfile, exit
//   stubborn    ignore SIGTERM
//   no-pidfile  graceful, but never write the pidfile
//   respawn     graceful, but start a graceful replacement first, the way a
//               serve still running would redial and start a new daemon

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [runtimeDir, mode = 'graceful'] = process.argv.slice(2)
const socket = path.join(runtimeDir, 'plumb.sock')
const pidFile = path.join(runtimeDir, 'plumb.pid')
fs.mkdirSync(runtimeDir, { recursive: true })
fs.rmSync(socket, { force: true })

const server = net.createServer((conn) => conn.destroy())
server.listen(socket, () => {
  if (mode !== 'no-pidfile') fs.writeFileSync(pidFile, String(process.pid))
  process.stdout.write('ready\n')
})

process.on('SIGTERM', () => {
  if (mode === 'stubborn') return
  server.close()
  fs.rmSync(pidFile, { force: true })
  if (mode === 'respawn') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), runtimeDir, 'graceful'], { detached: true, stdio: 'ignore' }).unref()
  }
  process.exit(0)
})
