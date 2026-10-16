// Where the e2e finds the dsh it drives, and the hoisted node_modules that dsh
// runs from (the scenario's throwaway DSH_HOME links it in as its profile tree).
//
// In order:
//   1. DSH_BIN. When it is set it is the answer: a DSH_BIN that does not exist is
//      an error, never a reason to look elsewhere, so a run (or a test) that
//      names a launcher gets that one or none.
//   2. The profile tree, `$DSH_HOME` or ~/.dsh, `profiles/node_modules`. dsh 0.1
//      kept `@deepseek-ai/dsh` there, linked to its install.
//   3. The npx cache, `$npm_config_cache` or ~/.npm, `_npx/<hash>/node_modules`.
//      dsh 0.2 runs from there (`npx @deepseek-ai/dsh@next`) and no longer keeps
//      the profile tree's link, which is left pointing at a deleted npx
//      directory once the cache is cleaned. Only when the cache holds exactly one
//      dsh: with several, which one the owner runs cannot be told.
// A launcher counts only when it exists, so a dangling link does not.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LAUNCHER = ['@deepseek-ai', 'dsh', 'lib', 'bin.js']

/**
 * @param {{env?: Record<string,string|undefined>, home?: string, exists?: (p: string) => boolean, list?: (dir: string) => string[]}} [options]
 * @returns {{bin: string, hoisted: string}}
 * @throws {Error} naming every place it looked, when none holds a dsh
 */
export function findDshLauncher({ env = process.env, home = os.homedir(), exists = fs.existsSync, list = listDir } = {}) {
  if (env.DSH_BIN) {
    if (!exists(env.DSH_BIN)) throw new Error(`DSH_BIN=${env.DSH_BIN} does not exist`)
    const hoisted = nearestNodeModules(env.DSH_BIN)
    if (!hoisted) {
      throw new Error(`DSH_BIN=${env.DSH_BIN} is not inside a node_modules tree, which the e2e links in as the scenario's profile tree — name the launcher inside one, such as <npm cache>/_npx/<hash>/node_modules/${LAUNCHER.join('/')}`)
    }
    return { bin: env.DSH_BIN, hoisted }
  }

  const profile = path.join(env.DSH_HOME || path.join(home, '.dsh'), 'profiles', 'node_modules')
  if (exists(path.join(profile, ...LAUNCHER))) return { bin: path.join(profile, ...LAUNCHER), hoisted: profile }

  const npx = path.join(env.npm_config_cache || path.join(home, '.npm'), '_npx')
  const found = list(npx)
    .map((entry) => path.join(npx, entry, 'node_modules'))
    .filter((tree) => exists(path.join(tree, ...LAUNCHER)))
  if (found.length === 1) return { bin: path.join(found[0], ...LAUNCHER), hoisted: found[0] }
  if (found.length > 1) {
    throw new Error(`${found.length} dsh installs in the npx cache, and which one you run cannot be told — set DSH_BIN to its launcher:\n${found.map((tree) => `  ${path.join(tree, ...LAUNCHER)}`).join('\n')}`)
  }
  throw new Error(`no dsh install found in the profile tree (${profile}) or the npx cache (${npx}) — set DSH_BIN to your dsh launcher (${LAUNCHER.join('/')} inside a node_modules tree)`)
}

/** The closest directory named node_modules above `from`, within eight levels, or null. */
export function nearestNodeModules(from) {
  let dir = path.dirname(path.resolve(from))
  for (let i = 0; i < 8 && dir !== path.parse(dir).root; i += 1) {
    if (path.basename(dir) === 'node_modules') return dir
    dir = path.dirname(dir)
  }
  return null
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}
