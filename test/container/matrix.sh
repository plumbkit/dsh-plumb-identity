#!/usr/bin/env bash
# The e2e's off-host acceptance matrix (PLAN-526): ten container runs that must
# each hold the daemon rules of test/container/run.sh, at most one plumb daemon
# at a time and none afterwards, on every way a run can end:
#
#   1-6  the full suite, every scenario passing
#   7    a red control (E2E_PER_AGENT=0): the scenario fails, teardown still runs
#   8    a dsh run timeout: the scenario fails, teardown still runs
#   9    SIGTERM to the runner mid-run: its signal handler tears down
#   10   SIGKILL to the runner mid-run: nothing in-process can tear down, so the
#        container's exit has to end its dsh, serve and daemon
#
#   test/container/matrix.sh --plumb <linux plumb binary> [--out <dir>]
#
# Each run's log and a summary go to --out (default: a new temp dir). The host's
# own plumb daemon count is recorded before and after each run and must not move.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
plumb=
out=
usage() {
  echo "usage: test/container/matrix.sh --plumb <linux plumb binary> [--out <dir>]" >&2
  exit 64
}
while [ $# -gt 0 ]; do
  case "$1" in
    --plumb) [ $# -ge 2 ] || usage; plumb=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || usage; out=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$plumb" ] || usage
out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/e2e-matrix.XXXXXX")}
mkdir -p "$out"

# The host's plumb daemons by exact command (argv[0] ending in plumb, then
# `daemon`), as census.mjs counts them in the container; "?" when ps cannot
# answer, or answers without listing this shell itself (an empty listing is
# not "no daemon"), which fails the run.
host_daemons() {
  local list
  list=$(ps -axo pid=,command=) || { echo '?'; return; }
  printf '%s\n' "$list" | grep -Eq "^ *$$ " || { echo '?'; return; }
  list=$(printf '%s\n' "$list" | sed -E 's/^ *[0-9]+ //')
  printf '%s\n' "$list" | grep -Ec '^([^ ]*/)?plumb daemon( |$)'
}

failed=0
summary="$out/summary.txt"
: > "$summary"

# run <n> <label> <env assignments...> -- <e2e args...>
run() {
  local n=$1 label=$2
  shift 2
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  local log="$out/run-$n.log" before after verdict gone
  before=$(host_daemons)
  local started=$SECONDS
  env ${envs[@]+"${envs[@]}"} "$here/../e2e-container.sh" --plumb "$plumb" "$@" > "$log" 2>&1
  local rc=$?
  after=$(host_daemons)
  verdict=$(grep -o 'verdict=[A-Z]*' "$log" | tail -1)
  gone=$(grep -c 'is gone, so every process it started has ended' "$log")
  local status=PASS
  [ "$rc" -eq 0 ] && [ "$verdict" = verdict=PASS ] && [ "$gone" -eq 1 ] && [ "$before" != '?' ] && [ "$after" != '?' ] && [ "$before" = "$after" ] || status=FAIL
  [ "$status" = PASS ] || failed=$((failed + 1))
  local line
  line=$(printf '%-3s %-28s %s exit=%s %s host_daemons=%s->%s %ss | %s' "$n" "$label" "$status" "$rc" "${verdict:-verdict=?}" "$before" "$after" "$((SECONDS - started))" "$(grep '^run: verdict=' "$log" | tail -1)")
  echo "$line" | tee -a "$summary"
}

for n in 1 2 3 4 5 6; do
  run "$n" "full suite" E2E_EXPECT=pass --
done
run 7 "red control (per-agent off)" E2E_EXPECT=fail E2E_PER_AGENT=0 \
  "E2E_EXPECT_FAIL_MATCH=^  FAIL per-agent: expected one connection per calling agent" -- --mode per-agent
run 8 "dsh run timeout" E2E_EXPECT=fail E2E_RUN_TIMEOUT_MS=6000 \
  "E2E_EXPECT_FAIL_MATCH=^  FAIL per-agent: dsh did not finish within 6000ms" -- --mode per-agent
run 9 "runner SIGTERM" E2E_SIGNAL_RUNNER=TERM E2E_SIGNAL_AFTER_MS=20000 --
run 10 "runner SIGKILL" E2E_SIGNAL_RUNNER=KILL E2E_SIGNAL_AFTER_MS=20000 --

echo "matrix: $((10 - failed))/10 passed; logs in $out" | tee -a "$summary"
[ "$failed" -eq 0 ]
