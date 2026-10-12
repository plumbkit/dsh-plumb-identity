#!/usr/bin/env node
// Count plumb daemons inside the e2e container (PLAN-526). Linux only: it reads
// /proc/<pid>/stat and cmdline, so a process counts only when its own argv is
// `<...>/plumb daemon [flags]`. A shell wrapper, a `plumb serve` or a grep
// that mentions "plumb daemon" does not. Zombies are skipped: their cmdline is
// empty, and under `docker run --init` they are reaped.
//
// A process that has forked but not yet exec'd is NOT a daemon, whatever its
// cmdline says: until exec, /proc/<pid>/cmdline still shows the parent's argv,
// so a daemon starting gopls or git briefly looks like a second daemon. Under
// CPU load that window is long enough for a 100 ms sample to see it (PLAN-526:
// four overlaps traced, each a single-sample child of the daemon). The kernel
// marks exactly that state: PF_FORKNOEXEC (0x40) in the flags of
// /proc/<pid>/stat (field 9), set by fork and cleared by exec. So stat is read
// FIRST: a flagged process is reported as `forked` and never counted; only then
// is cmdline read, which after exec is the process's own. A child that has
// exec'd a real `plumb daemon` counts, whatever its parent.
//
// It fails closed: only a process that exited between the listing and the read
// (ENOENT, ESRCH) is skipped. Any other error (EACCES, EIO, ...) means the
// census cannot see, so it throws, and watch/rescan exit non-zero instead of
// reporting "no daemon" (the ps-denied leak of PLAN-507, again).
//
//   census.mjs watch <file>   sample every 100 ms until SIGTERM, then write
//                             {"samples":N,"peak":P,"pids":[...]} to <file>
//   census.mjs rescan <ms>    sample every 100 ms for <ms>; print every daemon
//                             seen and exit 1 if there was any

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const GONE = new Set(['ENOENT', 'ESRCH'])

const PF_FORKNOEXEC = 0x40

/** One snapshot: the plumb daemons, and forked-not-yet-exec'd lookalikes. */
export function census(procRoot = '/proc', read = (file) => fs.readFileSync(file, 'utf8')) {
  const daemons = []
  const forked = []
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue
    let stat
    let argv
    try {
      stat = read(`${procRoot}/${name}/stat`)
      argv = read(`${procRoot}/${name}/cmdline`).split('\0').filter(Boolean)
    } catch (error) {
      if (GONE.has(error.code)) continue // exited between readdir and read
      throw new Error(`census: cannot read ${procRoot}/${name}: ${error.code ?? error.message}`)
    }
    // stat is "pid (comm) state ppid pgrp session tty tpgid flags ...", and comm
    // may hold spaces or ")": the greedy match ends at the last ") ". Anything
    // without that header, or naming another pid, is not trusted.
    const m = /^(\d+) \((.*)\) (.*)$/s.exec(stat.trimEnd())
    const fields = m && m[1] === name ? m[3].split(' ') : []
    const ppid = Number(fields[1])
    const flags = Number(fields[6])
    if (fields.length < 7 || !Number.isInteger(ppid) || !Number.isInteger(flags)) throw new Error(`census: cannot parse ${procRoot}/${name}/stat`)
    if (!(argv.length >= 2 && /(^|\/)plumb$/.test(argv[0]) && argv[1] === 'daemon')) continue
    const entry = { pid: Number(name), ppid, argv: argv.join(' ') }
    if (flags & PF_FORKNOEXEC) forked.push(entry)
    else daemons.push(entry)
  }
  return { daemons, forked }
}

/** The plumb daemons alive now (see census). */
export function plumbDaemons(procRoot = '/proc', read) {
  return census(procRoot, read).daemons
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Diagnostics only (never part of the verdict): a daemon's parent pid and HOME,
// so an overlap can be traced to the scenario and the process that started it.
function describe(pid) {
  const out = {}
  try { out.ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]) } catch {}
  try {
    const home = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((kv) => kv.startsWith('HOME='))
    if (home) out.home = home.slice(5)
  } catch {}
  return out
}

// Diagnostics only: copy every daemon.log under `home` to /tmp/overlap-logs a
// little after an overlap, so a lock loser's exit line or a serve's timeout is
// kept even though a passing scenario deletes its HOME.
function snapshotLogs(home, tag) {
  const outDir = '/tmp/overlap-logs'
  try {
    fs.mkdirSync(outDir, { recursive: true })
    const walk = (dir, depth) => {
      if (depth > 6) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p, depth + 1)
        else if (e.name === 'daemon.log') fs.copyFileSync(p, `${outDir}/${tag}-${p.replaceAll('/', '_')}`)
      }
    }
    walk(home, 0)
  } catch {}
}

async function watch(file) {
  let samples = 0
  let peak = 0
  const daemons = new Map() // pid -> { argv, first, last, ppid, home }
  const overlaps = [] // samples that saw more than one daemon
  let forkedSamples = 0 // samples that saw a daemon's pre-exec child (not counted)
  const forked = []
  let stop = false
  process.on('SIGTERM', () => { stop = true })
  while (!stop) {
    const snap = census()
    const now = snap.daemons
    const at = new Date().toISOString()
    if (snap.forked.length > 0) {
      forkedSamples += 1
      if (forked.length < 20) forked.push({ at, children: snap.forked })
    }
    samples += 1
    peak = Math.max(peak, now.length)
    for (const d of now) {
      const seen = daemons.get(d.pid)
      if (seen) seen.last = at
      else daemons.set(d.pid, { argv: d.argv, first: at, last: at, ...describe(d.pid) })
    }
    if (now.length > 1 && overlaps.length < 50) {
      overlaps.push({ at, pids: now.map((d) => d.pid) })
      const homes = new Set(now.map((d) => daemons.get(d.pid)?.home).filter(Boolean))
      if (overlaps.length === 1) for (const home of homes) setTimeout(() => snapshotLogs(home, `overlap1-${Date.now()}`), 2_000)
    }
    await sleep(100)
  }
  fs.writeFileSync(file, JSON.stringify({ samples, peak, pids: [...daemons.keys()], daemons: Object.fromEntries(daemons), overlaps, forkedSamples, forked }))
}

async function rescan(ms) {
  const seen = new Map()
  const end = Date.now() + ms
  let samples = 0
  while (Date.now() < end) {
    for (const d of plumbDaemons()) if (!seen.has(d.pid)) seen.set(d.pid, { ...d, at: new Date().toISOString() })
    samples += 1
    await sleep(100)
  }
  for (const d of seen.values()) console.log(`census: plumb daemon pid ${d.pid} seen at ${d.at}: ${d.argv}`)
  console.log(`census: rescan ${ms} ms, ${samples} samples, ${seen.size} daemon(s) seen`)
  process.exit(seen.size === 0 ? 0 : 1)
}

// Compare real paths: a URL check misses a path with a space or a symlink, and a
// rescan that silently does nothing would exit 0, which reads as clean.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, arg] = process.argv.slice(2)
  try {
    if (mode === 'watch' && arg) await watch(arg)
    else if (mode === 'rescan' && /^\d+$/.test(arg ?? '')) await rescan(Number(arg))
    else {
      console.error('usage: census.mjs watch <file> | rescan <ms>')
      process.exit(64)
    }
  } catch (error) {
    console.error(error.message) // the census could not see: never a clean count
    process.exit(2)
  }
}
