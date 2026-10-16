// A FAKE plumb for tests that drive the e2e (e2e-mock-provider.mjs) as a child
// process: a POSIX shell script that prints canned output and logs its arguments,
// built from shell builtins only so it runs with PATH=/nonexistent. It is not a
// daemon and can reach none; a test that points PLUMB_BIN at it cannot touch the
// developer's plumb, and one that forgets to would show it in the log.
//
// It answers the commands the e2e runs and exits 1 with "unknown command" for
// anything else, which the log then shows:
//   version                     a logo line and `plumb v0.26.0 (...)`
//   namespace --help            the probe's binary half
//   namespace list --json       the probe's daemon half
//   debug daemons               the n-th call prints the n-th listing (the last one
//                               repeats), so a test can replace the daemon mid-run
//   service show                a `[dirs]` table under the fake's own directory
//   namespace create ...        a fresh token and ns-fake<N> id
//   namespace release --json    revokes the namespace whose token is in PLUMB_NAMESPACE

import fs from 'node:fs'
import path from 'node:path'

export const FAKE_VERSION = 'plumb v0.26.0 (go1.27.2, rev ea5baa178c1c)'

/**
 * @param {string} dir  where the script, its listings, counters and log live
 * @param {{listings: string[], daemonsExit?: number, help?: number, list?: number, version?: string|null}} options
 *   `listings`: what successive `plumb debug daemons` calls print. `version`: the
 *   line `plumb version` prints, or null to make it fail.
 * @returns {{bin: string, dir: string, calls: () => string[]}}
 */
export function fakePlumb(dir, { listings, daemonsExit = 0, help = 0, list = 0, version = FAKE_VERSION } = {}) {
  if (!Array.isArray(listings) || listings.length === 0) throw new Error('fakePlumb: listings must name what `debug daemons` prints')
  const log = path.join(dir, 'plumb-calls.log')
  listings.forEach((text, i) => fs.writeFileSync(path.join(dir, `listing-${i + 1}.txt`), `${text}\n`))
  fs.copyFileSync(path.join(dir, `listing-${listings.length}.txt`), path.join(dir, 'listing-last.txt'))
  const data = path.join(dir, 'fake-data')
  const logs = path.join(dir, 'fake-logs')
  const bin = path.join(dir, 'plumb')
  const versionArm = version === null
    ? "  version::) printf 'no version\\n' >&2; exit 1 ;;"
    : `  version::) printf '%s\\n' ' ╭─╮ logo' '${version}'; exit 0 ;;`
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `D='${dir}'`,
    `printf '%s\\n' "$*" >> '${log}'`,
    // count NAME: n becomes the number of times NAME has been counted, this one included.
    'count() { n=0; [ -f "$D/count-$1" ] && read n < "$D/count-$1"; n=$((n+1)); printf \'%s\\n\' "$n" > "$D/count-$1"; }',
    'case "$1:$2:$3" in',
    versionArm,
    `  namespace:--help:*) printf 'create renew release list\\n'; exit ${help} ;;`,
    `  namespace:list:--json) printf 'null\\n'; exit ${list} ;;`,
    '  debug:daemons:)',
    '    count daemons; f="$D/listing-$n.txt"; [ -f "$f" ] || f="$D/listing-last.txt"',
    '    while IFS= read -r line; do printf \'%s\\n\' "$line"; done < "$f"',
    `    exit ${daemonsExit} ;;`,
    `  service:show:) printf '[dirs]\\ndata = %s\\nlog = %s\\n' "'${data}'" "'${logs}'"; exit 0 ;;`,
    '  namespace:create:*) count create; printf \'{"token":"tok-fake%s","namespace":{"id":"ns-fake%s"}}\\n\' "$n" "$n"; exit 0 ;;',
    '  namespace:release:*) printf \'{"namespace":{"id":"ns-fake%s","state":"revoked"}}\\n\' "${PLUMB_NAMESPACE#tok-fake}"; exit 0 ;;',
    'esac',
    "printf 'unknown command\\n' >&2",
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
  return { bin, dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}
