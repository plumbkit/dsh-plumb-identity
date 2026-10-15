// Host refusal for the e2e (PLAN-526). A developer machine runs exactly one plumb
// daemon: the one its own sessions use. The e2e's default isolation (PLAN-520)
// runs inside ONE daemon and gives each scenario a namespace of it; its older
// isolation (E2E_ISOLATION=daemon) starts a daemon per scenario. Neither is the
// owner's to start or to write rows into, so the suite runs only where it has a
// daemon that is not the owner's, and says so before it creates anything.
//
// Namespace isolation does NOT relax this, and a namespace token in the
// environment (PLUMB_NAMESPACE) is not evidence. A host run in namespace
// isolation against the owner's own daemon is a possible later step, once a
// namespace-capable plumb release is the one installed there; it is not enabled,
// and enabling it is a change to THIS file: a fourth kind of evidence, narrower
// than the three below (namespace isolation only, a plumb that passed the
// capability probe, an explicit opt-in naming the daemon), plus new shared
// vectors. Until then the refusal below is the whole story.
//
// This is a guard against running the suite here BY ACCIDENT (an agent, a
// habit, a stale recipe), not a security boundary: anyone can fake the
// evidence below. It accepts exactly three kinds of evidence:
//   - GITHUB_ACTIONS=true, on any OS: a hosted CI runner;
//   - Linux with a readable regular-file container marker, /.dockerenv
//     (Docker) or /run/.containerenv (Podman);
//   - Linux with PLUMB_SEPARATE_ENV=vm: an explicit declaration that this is a
//     disposable VM.
// Nothing else counts: no CI=true, no override flag, no case folding, and a
// marker that cannot be read counts as absent. The same vectors are tested for
// the Bash and Python copies of this rule in the plumb-ops harnesses.

import fs from 'node:fs'

export const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv']

/**
 * The kind of separate environment this process runs in, or null when it may be
 * a developer host.
 * @param {{env?: Record<string,string|undefined>, platform?: string, readable?: (p: string) => boolean}} [deps]
 * @returns {'github-actions'|'container'|'vm'|null}
 */
export function separateEnvironment({ env = process.env, platform = process.platform, readable = readableFile } = {}) {
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions'
  if (platform !== 'linux') return null
  if (CONTAINER_MARKERS.some((marker) => readable(marker))) return 'container'
  if (env.PLUMB_SEPARATE_ENV === 'vm') return 'vm'
  return null
}

/** True only for a regular file this process can open for reading. */
export function readableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.closeSync(fs.openSync(file, 'r'))
    return true
  } catch {
    return false
  }
}

/** The refusal printed when separateEnvironment() is null. */
export function refusal(what) {
  return [
    `${what}: refusing to run here: it drives a plumb daemon (with E2E_ISOLATION=daemon, starts`,
    'daemons of its own), and a developer machine must run exactly one plumb daemon, the one',
    'its sessions use, which a test is not to start, stop or write namespaces into.',
    'Run it in a separate environment instead:',
    '  test/e2e-container.sh --plumb <linux plumb binary>   (Docker; see README)',
    'Accepted evidence: GITHUB_ACTIONS=true; Linux with a readable /.dockerenv or',
    '/run/.containerenv; Linux with PLUMB_SEPARATE_ENV=vm (a disposable VM).',
  ].join('\n')
}
