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
//   npm run test:e2e                       all three scenarios
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
const RUN_TIMEOUT_MS = 180_000
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
  subagent: {
    task: 'Delegate one subagent with the subagent tool; it must use the mcp__plumb__daemon_info tool once. Then reply with exactly: done.',
    expect: async (ctx) => {
      const record = await pollForDeclared(ctx, (r) => r.purpose === 'dsh-subagent' && r.isIdentity)
      return record ? null : 'no plumb session record declared purpose "dsh-subagent" with external_id "dsh-*"'
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
    const home = buildDshHome({ root, fakeUrl: fake.url, plumbSh: writePlumbWrapper({ root, plumbBin }), hoisted: harness.hoisted })
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    const run = await runDsh(harness, ['--profile', 'e2e', task], {
      cwd: workspace,
      timeoutMs: RUN_TIMEOUT_MS,
      env: {
        ...process.env,
        DSH_HOME: home,
        FAKE_MODEL_KEY: 'dsh-plumb-identity-e2e',
        DSH_PERMISSION_MODE: 'danger-full-access',
        NO_COLOR: '1',
      },
    })
    if (run.timedOut) console.error(`  dsh timed out after ${RUN_TIMEOUT_MS}ms`)
    console.log(`  dsh exit=${run.code}${run.timedOut ? ' (timed out)' : ''}`)

    const problem = await SCENARIOS[mode].expect({ root })
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
    if (passed && !keep) fs.rmSync(root, { recursive: true, force: true })
    else console.log(`  (kept for debugging: ${root})`)
  }
  return passed
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
      const externalId = /"external_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null
      const purpose = /"purpose"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null
      if (externalId === null && purpose === null) continue
      // Minted ids are `dsh-<workspace-slug>-<short>`; main-conversation
      // shorts carry a `-session-` segment, subagent shorts are a bare uuid
      // fragment — so match the minted shape, not either convention.
      records.push({ file, externalId, purpose, isIdentity: /^dsh-[a-z0-9-]{12,}$/.test(externalId ?? '') })
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
