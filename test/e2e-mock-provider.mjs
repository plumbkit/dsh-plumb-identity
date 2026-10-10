#!/usr/bin/env node
// End-to-end verification of the identity plugin against a FAKE MODEL.
//
// Real DSH agent loop, this plugin mounted from the working tree, real plumb —
// only the model is scripted (see ./fake-model.mjs). The run therefore costs
// zero LLM credits and needs no network beyond localhost.
//
// Everything disposable lives in one temp root per scenario:
//   - a throwaway DSH_HOME whose only configured LLM provider is the local
//     fake, so a misrouted run fails on "unknown provider" instead of billing
//     a real key — OpenRouter is unreachable by construction;
//   - the harness's hoisted node_modules, symlinked in so DSH and the MCP SDK
//     resolve (the plugin's default sdkPath rides the same symlink);
//   - the plugin mounted via a `file://` patch row, so the working tree — the
//     code under test — is exactly what runs;
//   - an isolated `plumb serve`: its HOME and XDG roots are redirected under
//     the temp root, and session-manager (TSM_ORIG_*) companions are stripped
//     so plumb's hijack recovery cannot relocate the sandbox back at the real
//     user state. Assertions read plumb's own session records, never the mock.
//
// Usage:
//   npm run test:e2e                       every scenario
//   node test/e2e-mock-provider.mjs --mode tool-call [--mode subagent]
//   --keep / E2E_KEEP=1                    keep temp roots for debugging
//
// Requirements: a dsh install (DSH_BIN, else the $DSH_HOME / ~/.dsh profile
// tree, exactly what dsh itself resolves) and a plumb binary (PLUMB_BIN, else
// ../plumb/plumb beside this checkout, else `plumb` on PATH).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeModel } from './fake-model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_FILE = path.join(REPO_ROOT, 'dsh-plumb-identity.mjs')
const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS ?? 180_000)
const DECLARE_TIMEOUT_MS = 20_000

const SCENARIOS = {
  'tool-call': {
    task: 'Use the mcp__plumb__daemon_info tool once, then reply with exactly: done',
    expect: async (ctx) => {
      const record = await pollForDeclared(ctx, (r) => r.purpose === 'dsh' && r.isIdentity)
      return record ? null : 'no plumb session record declared purpose "dsh" with external_id "dsh-*"'
    },
  },
  'text-only': {
    task: 'Reply with exactly: done',
    expect: async (ctx) => {
      await sleep(2_000)
      const declared = readSessionRecords(ctx).filter((r) => r.purpose === 'dsh' || r.purpose === 'dsh-subagent')
      return declared.length === 0 ? null : `expected no declarations without a plumb tool call, found ${declared.map((r) => `${r.purpose}:${r.externalId}`).join(', ')}`
    },
  },
  // The proof of the per-agent design: TWO agents call plumb, so the shared
  // design yields ONE connection carrying stamped identities, while this design
  // yields one connection EACH, declaring on itself. The control is the same
  // scenario run with `perAgentConnection: false`, which leaves the shared row
  // carrying the identity and no `dsh-plumb-identity` record at all.
  'per-agent': {
    task: 'Use the mcp__plumb__daemon_info tool once. Then delegate one subagent with the subagent tool; the subagent must also use the mcp__plumb__daemon_info tool once. Then reply with exactly: done.',
    expect: async (ctx) => {
      const deadline = Date.now() + DECLARE_TIMEOUT_MS
      let perAgent = []
      while (Date.now() < deadline) {
        perAgent = readSessionRecords(ctx).filter((r) => r.clientName === 'dsh-plumb-identity')
        const seen = new Set(perAgent.map((r) => r.purpose))
        if (seen.has('dsh') && seen.has('dsh-subagent')) break
        await sleep(500)
      }
      if (perAgent.length < 2) {
        return `expected one connection per calling agent (2), found ${perAgent.length}: ${perAgent.map((r) => `${r.clientName}/${r.purpose}`).join(', ') || 'none'}`
      }
      const ids = new Set(perAgent.map((r) => r.externalId))
      if (ids.size !== perAgent.length) return `two agents shared one external id: ${[...ids].join(', ')}`
      const purposes = new Set(perAgent.map((r) => r.purpose))
      if (!purposes.has('dsh') || !purposes.has('dsh-subagent')) {
        return `expected the conversation and the subagent to declare, got purposes ${[...purposes].join(', ')}`
      }
      // The shared row is still there (it serves discovery) but must carry NO
      // declaration: that is the difference between routing the call and merely
      // stamping the shared connection.
      const shared = readSessionRecords(ctx).filter((r) => r.clientName === 'dsh-mcp-client')
      if (shared.some((r) => r.isIdentity)) {
        return 'the shared connection carries a declaration — the call did not move off it'
      }
      return null
    },
  },
  subagent: {
    task: 'Delegate one subagent with the subagent tool; it must use the mcp__plumb__daemon_info tool once. Then reply with exactly: done.',
    expect: async (ctx) => {
      const record = await pollForDeclared(ctx, (r) => r.purpose === 'dsh-subagent' && r.isIdentity)
      if (!record) return 'no plumb session record declared purpose "dsh-subagent" with external_id "dsh-*"'
      // The declaration must sit on the SUBAGENT's own connection, not on the
      // shared one: that is the whole difference between routing a call and
      // stamping an identity onto a connection everybody shares.
      if (record.clientName !== 'dsh-plumb-identity') {
        return `the subagent declared over "${record.clientName}", not its own connection`
      }
      if (readSessionRecords(ctx).some((r) => r.clientName === 'dsh-mcp-client' && r.isIdentity)) {
        return 'the shared connection also carries a declaration — a call did not move off it'
      }
      return null
    },
  },
  // PLAN-500. A note is waiting for whoever attaches next BEFORE the agent's
  // first plumb call. That call makes the plugin declare the agent with an
  // AUTOMATIC session_start, whose packet the model never sees. If that
  // session_start claims mail (plumb's default), the note is consumed there
  // and check_messages returns nothing. With `mail: 'preview'` it is still
  // waiting, and the model receives it from check_messages, exactly once.
  // Control: delete the plugin's `mail: 'preview'` and this scenario fails.
  // (A note sent WHILE the agent is connected is a different defect, PLAN-463,
  // and is deliberately not tested here.)
  mail: {
    task: 'Use the mcp__plumb__daemon_info tool once, then the mcp__plumb__check_messages tool once, then reply with exactly: done',
    setup: fileWaitingNote,
    expect: async ({ fake, setup }) => {
      const results = fake.toolResults
      if (!results.some((r) => /check_messages$/.test(r.name ?? ''))) {
        return `the model never received a check_messages result (tool results: ${results.map((r) => r.name).join(', ') || 'none'})`
      }
      const hits = results.flatMap((r) => Array(r.content.split(setup.marker).length - 1).fill(r.name))
      if (hits.length === 0) {
        return 'the waiting note never reached the model: it was claimed where the model cannot see it (the automatic session_start)'
      }
      if (hits.length > 1) return `the waiting note reached the model ${hits.length} times (${hits.join(', ')}), expected exactly once`
      if (!/check_messages$/.test(hits[0] ?? '')) return `the waiting note reached the model through ${hits[0]}, not check_messages`
      return null
    },
  },
}

main().catch((error) => {
  console.error(`e2e: ${error.message}`)
  process.exit(1)
})

async function main() {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep') || process.env.E2E_KEEP === '1'
  const wanted = args.includes('--mode') ? args.flatMap((a, i) => (a === '--mode' ? [args[i + 1]] : [])) : Object.keys(SCENARIOS)
  for (const mode of wanted) {
    if (!SCENARIOS[mode]) throw new Error(`unknown scenario "${mode}" (expected one of ${Object.keys(SCENARIOS).join(', ')})`)
  }

  const harness = resolveHarness()
  const plumbBin = resolvePlumb()
  console.log(`e2e: harness ${harness.label}`)
  console.log(`e2e: plumb   ${plumbBin}`)
  console.log(`e2e: plugin  ${PLUGIN_FILE}`)

  let failures = 0
  for (const mode of wanted) {
    const passed = await runScenario({ mode, task: SCENARIOS[mode].task, harness, plumbBin, keep })
    if (!passed) failures += 1
  }
  console.log(failures === 0 ? `\ne2e: all ${wanted.length} scenario(s) passed` : `\ne2e: ${failures} scenario(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

// -- one scenario ----------------------------------------------------------------

async function runScenario({ mode, task, harness, plumbBin, keep }) {
  // Scenario roots must live shallow: the isolated plumb daemon's Unix socket
  // is $HOME-derived, and macOS's default per-user temp dir alone blows past
  // the 104-byte sun_path ceiling (plumb refuses with exactly that hint).
  const parent = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  const root = fs.mkdtempSync(path.join(parent, `dsh-identity-e2e-${mode}-`))
  let fake
  let passed = false
  console.log(`\n=== ${mode} ===`)
  try {
    fake = await createFakeModel({ mode, log: (line) => console.log(`  ${line}`) })
    const plumbSh = writePlumbWrapper({ root, plumbBin })
    const home = buildDshHome({ root, fakeUrl: fake.url, plumbSh, hoisted: harness.hoisted })
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    const setup = SCENARIOS[mode].setup ? await SCENARIOS[mode].setup({ workspace, plumbSh }) : {}

    const run = await runDsh(harness, ['--profile', 'e2e', task], {
      cwd: workspace,
      timeoutMs: RUN_TIMEOUT_MS,
      env: {
        ...process.env,
        DSH_HOME: home,
        // The plugin spawns its OWN `plumb serve` per agent, and resolves it as
        // config.plumbCommand -> $PLUMB_BIN -> `plumb` on PATH. Without this the
        // per-agent connections use the ambient HOME and talk to the
        // developer's real daemon instead of this scenario's isolated one.
        PLUMB_BIN: plumbSh,
        FAKE_MODEL_KEY: 'dsh-plumb-identity-e2e',
        DSH_PERMISSION_MODE: 'danger-full-access',
        NO_COLOR: '1',
        PLUMB_IDENTITY_DEBUG: process.env.PLUMB_IDENTITY_DEBUG ?? '',
      },
    })
    if (run.timedOut) console.error(`  dsh timed out after ${RUN_TIMEOUT_MS}ms`)
    console.log(`  dsh exit=${run.code}${run.timedOut ? ' (timed out)' : ''}`)

    const problem = await SCENARIOS[mode].expect({ root, fake, setup })
    if (problem === null) {
      console.log(`  PASS ${mode}`)
      passed = true
    } else {
      console.error(`  FAIL ${mode}: ${problem}`)
    }
  } catch (error) {
    console.error(`  FAIL ${mode}: ${error.message}`)
  } finally {
    if (fake) await fake.close()
    // PLAN-507: `plumb serve` daemonizes this scenario's plumb daemon, so
    // nothing above ends it, and before this every run leaked one per
    // scenario. Stop it on pass AND fail, before its HOME is deleted, and fail
    // the scenario if it survives.
    const leaked = await stopIsolatedDaemon(root)
    if (leaked.length > 0) {
      console.error(`  FAIL ${mode}: the isolated plumb daemon survived teardown (pid ${leaked.join(', ')})`)
      passed = false
    }
    if (passed && !keep) fs.rmSync(root, { recursive: true, force: true })
    else console.log(`  (kept for debugging: ${root})`)
  }
  return passed
}

/**
 * Leave a note for whoever attaches to `workspace` next, from a short-lived
 * plumb session of its own (plumb's CLI cannot send mail). Speaks MCP's stdio
 * framing directly, one JSON-RPC message per line, so the harness needs no SDK.
 * Returns the note's unique marker.
 */
async function fileWaitingNote({ workspace, plumbSh }) {
  const marker = `plan500-waiting-note-${process.pid}-${Date.now()}`
  const child = spawn(plumbSh, ['serve'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  const pending = new Map()
  let buffered = ''
  child.stdout.on('data', (data) => {
    buffered += data
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  let nextId = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out; plumb stderr: ${stderr.slice(-400)}`)), DECLARE_TIMEOUT_MS)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const toolCall = async (toolName, args) => {
    const reply = await call('tools/call', { name: toolName, arguments: args })
    if (reply.error || reply.result?.isError === true) {
      const why = reply.error?.message ?? (reply.result?.content ?? []).map((part) => part.text).join(' ')
      throw new Error(`${toolName} failed: ${String(why).slice(0, 300)}`)
    }
    return reply.result
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-identity-e2e-sender', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    await toolCall('session_start', { session_id: 'dsh-identity-e2e-sender', workspace })
    await toolCall('leave_note', { to: 'next', body: marker })
    console.log(`  setup: left a note for the next session (${marker})`)
  } finally {
    child.stdin.end()
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 5_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  return { marker }
}

/**
 * Stop this scenario's isolated plumb daemon, found by the pidfile it keeps
 * under the scenario's own HOME, never by a process-wide sweep. A graceful
 * SIGTERM, then a bounded wait. The process is confirmed to be a plumb daemon
 * before it is signalled, so a stale pidfile can't hit an unrelated process.
 * Returns the pids still alive afterwards.
 */
async function stopIsolatedDaemon(root) {
  const plumbHome = path.join(root, 'plumbhome')
  if (!fs.existsSync(plumbHome)) return []
  const pids = walkDirs(plumbHome, 0)
    .map((dir) => path.join(dir, 'plumb.pid'))
    .filter((file) => fs.existsSync(file))
    .map((file) => Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && isPlumbDaemon(pid))
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && pids.some(isAlive)) await sleep(200)
  const leaked = pids.filter(isAlive)
  if (pids.length > 0 && leaked.length === 0) console.log(`  teardown: stopped the isolated plumb daemon (pid ${pids.join(', ')})`)
  return leaked
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function isPlumbDaemon(pid) {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return ps.status === 0 && /\bplumb\b.*\bdaemon\b/.test(ps.stdout)
}

// -- throwaway environment ---------------------------------------------------------

function buildDshHome({ root, fakeUrl, plumbSh, hoisted }) {
  const home = path.join(root, 'dsh-home')
  const profile = path.join(home, 'profiles', 'e2e')
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(hoisted, path.join(home, 'profiles', 'node_modules'), 'dir')

  fs.writeFileSync(path.join(home, 'settings.yaml'), `\
# Throwaway DSH home for the dsh-plumb-identity e2e. The ONLY LLM provider is
# the local fake, so a misrouted model request fails fast instead of billing.
agent-default-model:
  provider: dsh-identity-fake
  model: fake-1
llm-pi-ai:
  providers:
    dsh-identity-fake:
      displayName: dsh-plumb-identity e2e fake
      apiKeyEnv: FAKE_MODEL_KEY
      api: openai-completions
      baseURL: ${fakeUrl}
      models:
        - id: fake-1
          name: Fake One
          contextWindow: 131072
          maxTokens: 8192
`)

  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-identity-e2e',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2)}\n`)

  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), `\
# Mounts the plugin from THIS checkout (the code under test) above the isolated
# plumb mcp-client row. Order is irrelevant to correctness — the plugin
# captures the plumb client during the SDK's tools sync — but matches the
# bundle-patch convention.
- insert:
    - id: dsh-plumb-identity
      name: '${`file://${PLUGIN_FILE}`}'
      config:
        serverName: plumb
        logEvents: true
        # E2E_PER_AGENT=0 runs the SAME scenario on the shared connection: the
        # control that proves the per-agent assertions fail if the feature
        # silently reverts to stamping.
        perAgentConnection: ${process.env.E2E_PER_AGENT === '0' ? 'false' : 'true'}
        # 60 s here unless E2E_IDLE_MS says otherwise (a smaller value ends
        # each run sooner); the plugin's production default is 15 s.
        idleMs: ${Number(process.env.E2E_IDLE_MS ?? 60000)}
    - id: mcp-plumb
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: plumb
        transport: stdio
        command: ${plumbSh}
        args:
          - serve
`)
  return home
}

/**
 * The plumb side of the scenario must not touch the developer's real daemon
 * state, so the mcp row's command is a wrapper that relocates every writable
 * plumb root under the temp tree. TSM_ORIG_* companions are stripped because
 * plumb's session-manager hijack recovery would otherwise see a temp XDG
 * override and "recover" it back at the real user state.
 */
function writePlumbWrapper({ root, plumbBin }) {
  const home = path.join(root, 'plumbhome')
  const xdg = (base) => path.join(home, base)
  const wrapper = path.join(root, 'plumb-isolated.sh')
  fs.writeFileSync(wrapper, `\
#!/bin/sh
# Generated by test/e2e-mock-provider.mjs — isolated plumb serve.
HOME='${home}'
export HOME
XDG_CONFIG_HOME='${xdg('.config')}'
XDG_DATA_HOME='${xdg('.local/share')}'
XDG_STATE_HOME='${xdg('.local/state')}'
XDG_CACHE_HOME='${xdg('.cache')}'
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
unset TSM_ORIG_HOME TSM_ORIG_XDG_CONFIG_HOME TSM_ORIG_XDG_DATA_HOME TSM_ORIG_XDG_STATE_HOME TSM_ORIG_XDG_CACHE_HOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \\
  "$HOME/Library/Caches" "$HOME/Library/Logs"
exec '${plumbBin}' serve
`)
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

// -- plumb-side assertions ---------------------------------------------------------

/**
 * Wait until a session record satisfying `predicate` shows up in the isolated
 * plumb state — plumb writes the declaration server-side during the run, so
 * after the dsh process exits it is a short bounded wait at most.
 */
async function pollForDeclared(ctx, predicate) {
  const deadline = Date.now() + DECLARE_TIMEOUT_MS
  for (;;) {
    const hit = readSessionRecords(ctx).find(predicate)
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await sleep(500)
  }
}

/**
 * Read every declared-session record from the isolated plumb state. The
 * sessions directory's exact parent differs by platform/XDG resolution, so it
 * is located by walking the temp plumbhome; record files are JSON whose
 * external_id/purpose fields are matched tolerantly (the minted identity is
 * recognized by the plugin's "dsh-" prefix and a session-style tail).
 */
function readSessionRecords({ root }) {
  const plumbHome = path.join(root, 'plumbhome')
  if (!fs.existsSync(plumbHome)) return []
  const records = []
  for (const dir of walkDirs(plumbHome, 0)) {
    if (path.basename(dir) !== 'sessions') continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(dir, entry.name)
      const text = fs.readFileSync(file, 'utf8')
      let record = null
      try {
        record = JSON.parse(text)
      } catch {
        // A half-written record is retried by the next poll.
        continue
      }
      const externalId = typeof record.external_id === 'string' ? record.external_id : null
      const purpose = typeof record.purpose === 'string' ? record.purpose : null
      // Who opened the connection. The plugin's per-agent clients name
      // themselves `dsh-plumb-identity`; the shared MCP row is `dsh-mcp-client`.
      // This is what distinguishes "one connection per agent" from "one shared
      // connection carrying a stamped identity" — the two designs produce the
      // same declaration count, only the client differs.
      const clientName = typeof record.client_name === 'string' ? record.client_name : null
      if (externalId === null && purpose === null && clientName === null) continue
      // Minted ids are `dsh-<workspace-slug>-<short>`; main-conversation
      // shorts carry a `-session-` segment, subagent shorts are a bare uuid
      // fragment — so match the minted shape, not either convention.
      records.push({ file, clientName, externalId, purpose, isIdentity: /^dsh-[a-z0-9-]{12,}$/.test(externalId ?? '') })
    }
  }
  return records
}

function walkDirs(dir, depth) {
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

// -- process + path resolution helpers ----------------------------------------------

/** Resolve the dsh launcher: DSH_BIN, else the profile tree dsh itself uses. */
function resolveHarness() {
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  candidates.push(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const bin = candidates.find((p) => fs.existsSync(p))
  if (!bin) {
    throw new Error('no dsh install found — set DSH_BIN to your dsh launcher (or dsh lib/bin.js)')
  }
  const hoisted = nearestNodeModules(bin)
  if (!hoisted) {
    throw new Error(`cannot locate the hoisted profile node_modules above ${bin} — set DSH_BIN to a path under the profile tree`)
  }
  return {
    label: bin,
    bin,
    hoisted,
    argv: (args) => (bin.endsWith('.js') ? [process.execPath, bin, ...args] : [bin, ...args]),
  }
}

function nearestNodeModules(from) {
  let dir = path.dirname(path.resolve(from))
  for (let i = 0; i < 8 && dir !== path.parse(dir).root; i += 1) {
    if (path.basename(dir) === 'node_modules') return dir
    dir = path.dirname(dir)
  }
  return null
}

/** Resolve the plumb binary: PLUMB_BIN, ../plumb/plumb, or PATH. */
function resolvePlumb() {
  const candidates = [
    process.env.PLUMB_BIN,
    path.join(REPO_ROOT, '..', 'plumb', 'plumb'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const onPath = spawnSync('plumb', ['version'], { encoding: 'utf8' })
  if (!onPath.error) return 'plumb'
  throw new Error('no plumb binary found — set PLUMB_BIN (the e2e drives a real, isolated `plumb serve`)')
}

/**
 * Run the dsh launcher to completion, streaming its output through with a
 * scenario prefix, and enforce the run timeout.
 */
function runDsh(harness, args, { cwd, env, timeoutMs }) {
  const [file, ...spawnArgs] = harness.argv(args)
  return new Promise((resolve) => {
    const child = spawn(file, spawnArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
      process.stdout.write(`${data}`)
    })
    child.stderr.on('data', (data) => {
      stderr += data
      process.stderr.write(`${data}`)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error(`  dsh spawn failed: ${error.message}`)
      resolve({ code: 1, stdout, stderr, timedOut })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
