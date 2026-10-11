// Teardown for the e2e's per-scenario isolated plumb daemon (PLAN-507).
//
// `plumb serve` daemonizes the scenario's plumb daemon, so nothing in the run
// ends it. This stops it, and refuses to call the scenario clean unless it can
// show the daemon is gone.
//
// The first version of this teardown found the daemon by its pidfile and then
// skipped any pid that `ps` would not confirm as a plumb daemon. Inside an
// agent's sandbox `ps` is denied, so every pid was skipped, nothing was
// signalled, "nothing found" read as "nothing survived", and the harness
// deleted each root with its daemon still running: 64 daemons leaked in one
// afternoon. So `ps` is now only a veto when it answers, and the verdict comes
// from the daemon's own socket, which a connect probes without `ps`: a socket
// under the scenario's HOME that still accepts a connection is a live daemon,
// whatever the pid search found.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/**
 * Stop the plumb daemon(s) running under `plumbHome`, the scenario's private
 * HOME, never by a process-wide sweep.
 *
 * Returns `{ stopped, problems }`: the pids that were signalled and exited,
 * and every reason the scenario must not be called clean. An empty `problems`
 * means no plumb socket under `plumbHome` accepts a connection, no pidfile
 * there names a live process, and both still held after `settleMs`, so a
 * daemon respawned by a lingering serve is caught too.
 */
export async function stopIsolatedDaemon(plumbHome, {
  probeCommand = psCommand,
  stopWaitMs = 10_000,
  settleMs = 2_000,
} = {}) {
  const problems = []
  const stopped = []
  if (!fs.existsSync(plumbHome)) return { stopped, problems }

  const listeningBefore = await listeningSockets(plumbHome)
  const targets = []
  const foreign = []
  for (const pid of pidfilePids(plumbHome)) {
    if (!isAlive(pid)) continue
    const command = probeCommand(pid)
    if (command === null) {
      // `ps` could not answer (a sandbox denies it). The pidfile is written by
      // the daemon holding this HOME's lifetime lock, and a socket here that
      // accepts connections proves that holder is alive, so the pid is ours.
      // Without a listening socket the pid may be a reused one: report it
      // rather than signal a process that may not be plumb.
      if (listeningBefore.length > 0) targets.push(pid)
      else problems.push(`pid ${pid} from a pidfile under ${plumbHome} is alive, but ps is unavailable and no plumb socket there is listening, so it cannot be confirmed as this scenario's daemon`)
    } else if (/\bplumb\b.*\bdaemon\b/.test(command)) {
      targets.push(pid)
    } else {
      // ps says this is some other process: a stale pidfile whose pid was reused.
      foreign.push(pid)
    }
  }

  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') problems.push(`could not signal pid ${pid}: ${error.code ?? error.message}`)
    }
  }
  const deadline = Date.now() + stopWaitMs
  while (Date.now() < deadline && targets.some(isAlive)) await sleep(100)
  for (const pid of targets) {
    if (isAlive(pid)) problems.push(`pid ${pid} survived SIGTERM for ${stopWaitMs} ms`)
    else stopped.push(pid)
  }

  // Settle, then look again: a serve still running could have respawned a
  // daemon after the one above exited.
  await sleep(settleMs)
  for (const socket of await listeningSockets(plumbHome)) {
    problems.push(`a plumb daemon is still listening on ${socket}`)
  }
  for (const pid of pidfilePids(plumbHome)) {
    if (isAlive(pid) && !targets.includes(pid) && !foreign.includes(pid)) problems.push(`a pidfile under ${plumbHome} names live pid ${pid} after teardown`)
  }
  return { stopped, problems }
}

/**
 * End process group `pgid` (a dsh run and every serve it started): SIGTERM, a
 * bounded wait, then SIGKILL. Returns null once the group is gone, else the
 * problem.
 */
export async function endProcessGroup(pgid, { waitMs = 5_000 } = {}) {
  if (!groupAlive(pgid)) return null
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') return `could not signal process group ${pgid}: ${error.code ?? error.message}`
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && groupAlive(pgid)) await sleep(100)
  if (!groupAlive(pgid)) return null
  try { process.kill(-pgid, 'SIGKILL') } catch { /* gone meanwhile */ }
  await sleep(500)
  return groupAlive(pgid) ? `process group ${pgid} survived SIGKILL` : null
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The command line of `pid`, or null when `ps` cannot be run or answers nothing. */
export function psCommand(pid) {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  if (ps.error || ps.status !== 0) return null
  const command = ps.stdout.trim()
  return command === '' ? null : command
}

function pidfilePids(plumbHome) {
  return walkDirs(plumbHome, 0)
    .map((dir) => path.join(dir, 'plumb.pid'))
    .filter((file) => fs.existsSync(file))
    .map((file) => Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1)
}

async function listeningSockets(plumbHome) {
  const sockets = walkDirs(plumbHome, 0)
    .map((dir) => path.join(dir, 'plumb.sock'))
    .filter((file) => fs.existsSync(file))
  const live = []
  for (const socket of sockets) {
    if (await accepts(socket)) live.push(socket)
  }
  return live
}

/**
 * Whether a Unix socket accepts a connection. A probe that neither connects
 * nor fails within a second counts as listening: a wedged daemon is not a
 * stopped one.
 */
function accepts(socket) {
  return new Promise((resolve) => {
    const conn = net.createConnection({ path: socket })
    const done = (listening) => {
      clearTimeout(timer)
      conn.destroy()
      resolve(listening)
    }
    const timer = setTimeout(() => done(true), 1_000)
    conn.once('connect', () => done(true))
    conn.once('error', () => done(false))
  })
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function walkDirs(dir, depth) {
  if (depth > 8) return []
  const out = [dir]
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...walkDirs(path.join(dir, entry.name), depth + 1))
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
