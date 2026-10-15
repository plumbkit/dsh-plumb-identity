#!/usr/bin/env bash
# The e2e's off-host acceptance matrix (PLAN-526, PLAN-520): container runs that
# must each hold the daemon rules of test/container/run.sh, at most one plumb
# daemon at a time and none afterwards, on every way a run can end.
#
# Rows 1-10 run in the default isolation, NAMESPACE (one daemon, started once by
# run.sh, a plumb namespace per scenario; the census must show exactly one daemon
# pid for the whole run and no namespace left active):
#
#   1-6  the full suite, every scenario passing
#   7    a red control (E2E_PER_AGENT=0): the scenario fails, teardown still runs
#   8    a dsh run timeout: the scenario fails, teardown still runs
#   9    SIGTERM to the runner mid-run: its signal handler releases the namespace
#   10   SIGKILL to the runner mid-run: nothing in-process can release; the
#        namespace stays active, owned by the dead runner's pid (`--owner-pid`
#        expires it), and the container's exit ends the daemon, dsh and serves
#
# Rows 11-13 are the same, in the older isolation (E2E_ISOLATION=daemon, a daemon
# per scenario under a private HOME), so the older path does not rot:
#
#   11   the full suite
#   12   SIGTERM to the runner mid-run: its handler stops the scenario's daemon
#   13   SIGKILL to the runner mid-run: the container's exit has to end its daemon
#
# Row 14 runs only with --plumb-old, a linux plumb WITHOUT namespaces:
#
#   14   the refusal control: the default isolation must REFUSE it (exit 2, the
#        "namespace isolation is unavailable" message), never fall back to a
#        daemon per scenario, and the census must still show the one daemon
#
#   test/container/matrix.sh --plumb <linux plumb binary> [--plumb-old <linux plumb without namespaces>] [--out <dir>] [--only <n,n,...>]
#
# --only runs just those rows (to re-run a row that failed for a reason outside the
# e2e; the rows that were not asked for are neither run nor counted).
#
# Each run's log and a summary go to --out (default: a new temp dir). The host's
# own plumb daemon count is recorded before and after each run and must not move.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
plumb=
plumb_old=
out=
only=
usage() {
  echo "usage: test/container/matrix.sh --plumb <linux plumb binary> [--plumb-old <linux plumb without namespaces>] [--out <dir>] [--only <n,n,...>]" >&2
  exit 64
}
while [ $# -gt 0 ]; do
  case "$1" in
    --plumb) [ $# -ge 2 ] || usage; plumb=$2; shift 2 ;;
    --plumb-old) [ $# -ge 2 ] || usage; plumb_old=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || usage; out=$2; shift 2 ;;
    --only) [ $# -ge 2 ] || usage; only=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$plumb" ] || usage
[ -z "$only" ] || [[ "$only" =~ ^[0-9]+(,[0-9]+)*$ ]] || usage
if [ -n "$only" ]; then
  for r in ${only//,/ }; do
    { [ "$r" -ge 1 ] && [ "$r" -le 14 ]; } || { echo "matrix: --only names row $r; rows are 1-14" >&2; exit 64; }
  done
fi
out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/e2e-matrix.XXXXXX")}
mkdir -p "$out"

# The host's plumb daemons by exact command (argv[0] ending in plumb, then
# `daemon`), as census.mjs counts them in the container; "?" when ps cannot
# answer, or answers without listing this shell itself (an empty listing is
# not "no daemon"), which fails the run.
# ps is asked up to five times: on a machine busy enough, one call can fail or
# come back without this shell in it, and a row's verdict should not turn on that.
# Still fail-closed: five bad answers in a row are "?".
host_daemons() {
  local list attempt
  for attempt in 1 2 3 4 5; do
    if list=$(ps -axo pid=,command= 2> /dev/null) && printf '%s\n' "$list" | grep -Eq "^ *$$ "; then
      list=$(printf '%s\n' "$list" | sed -E 's/^ *[0-9]+ //')
      printf '%s\n' "$list" | grep -Ec '^([^ ]*/)?plumb daemon( |$)'
      return
    fi
    sleep 1
  done
  echo '?'
}

failed=0
ran=0
not_run=
summary="$out/summary.txt"
: > "$summary"

# run <n> <label> <env assignments...> -- <e2e args...>
# PLUMB_FOR_RUN=<binary> run ...  runs it against that plumb instead of --plumb.
run() {
  local n=$1 label=$2 bin=${PLUMB_FOR_RUN:-$plumb}
  if [ -n "$only" ] && [[ ",$only," != *",$n,"* ]]; then
    return 0
  fi
  ran=$((ran + 1))
  shift 2
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  local log="$out/run-$n.log" before after verdict gone
  before=$(host_daemons)
  local started=$SECONDS
  env ${envs[@]+"${envs[@]}"} "$here/../e2e-container.sh" --plumb "$bin" "$@" > "$log" 2>&1
  local rc=$?
  after=$(host_daemons)
  verdict=$(grep -o 'verdict=[A-Z]*' "$log" | tail -1)
  gone=$(grep -c 'is gone, so every process it started has ended' "$log")
  local status=PASS
  # The row ran in the isolation it is labelled for: an ambient E2E_ISOLATION
  # on the host must not turn a namespace row into a daemon one that passes.
  local want_iso=namespace got_iso
  for kv in ${envs[@]+"${envs[@]}"}; do [ "$kv" = E2E_ISOLATION=daemon ] && want_iso=daemon; done
  got_iso=$(grep -o 'isolation=[a-z]*' "$log" | tail -1)
  [ "$rc" -eq 0 ] && [ "$verdict" = verdict=PASS ] && [ "$gone" -eq 1 ] && [ "$before" != '?' ] && [ "$after" != '?' ] && [ "$before" = "$after" ] || status=FAIL
  # A refusal row stops before the isolation is reported; every other row must say it.
  [ "$n" = 14 ] || [ "$got_iso" = "isolation=$want_iso" ] || status=FAIL
  [ "$status" = PASS ] || failed=$((failed + 1))
  local line
  line=$(printf '%-3s %-28s %s exit=%s %s host_daemons=%s->%s %ss | %s' "$n" "$label" "$status" "$rc" "${verdict:-verdict=?}" "$before" "$after" "$((SECONDS - started))" "$(grep '^run: verdict=' "$log" | tail -1)")
  echo "$line" | tee -a "$summary"
}

for n in 1 2 3 4 5 6; do
  run "$n" "full suite" E2E_ISOLATION=namespace E2E_EXPECT=pass --
done
run 7 "red control (per-agent off)" E2E_ISOLATION=namespace E2E_EXPECT=fail E2E_PER_AGENT=0 \
  "E2E_EXPECT_FAIL_MATCH=^  FAIL per-agent: expected one connection per calling agent" -- --mode per-agent
run 8 "dsh run timeout" E2E_ISOLATION=namespace E2E_EXPECT=fail E2E_RUN_TIMEOUT_MS=6000 \
  "E2E_EXPECT_FAIL_MATCH=^  FAIL per-agent: dsh did not finish within 6000ms" -- --mode per-agent
run 9 "runner SIGTERM" E2E_ISOLATION=namespace E2E_SIGNAL_RUNNER=TERM E2E_SIGNAL_AFTER_MS=20000 --
run 10 "runner SIGKILL" E2E_ISOLATION=namespace E2E_SIGNAL_RUNNER=KILL E2E_SIGNAL_AFTER_MS=20000 --
run 11 "daemon isolation, suite" E2E_ISOLATION=daemon E2E_EXPECT=pass --
run 12 "daemon isolation, SIGTERM" E2E_ISOLATION=daemon E2E_SIGNAL_RUNNER=TERM E2E_SIGNAL_AFTER_MS=20000 --
run 13 "daemon isolation, SIGKILL" E2E_ISOLATION=daemon E2E_SIGNAL_RUNNER=KILL E2E_SIGNAL_AFTER_MS=20000 --
if [ -n "$plumb_old" ]; then
  PLUMB_FOR_RUN=$plumb_old run 14 "refusal: plumb w/o namespaces" E2E_EXPECT=fail \
    "E2E_EXPECT_FAIL_MATCH=^e2e: namespace isolation is unavailable: " -- --mode per-agent
elif [ -z "$only" ] || [[ ",$only," == *",14,"* ]]; then
  # Said, not skipped quietly, and not counted as a pass: the summary line carries it.
  echo "14  refusal: plumb w/o namespaces  NOT RUN (pass --plumb-old <linux plumb without namespaces>)" | tee -a "$summary"
  not_run=" (row 14 NOT RUN: no --plumb-old)"
fi

echo "matrix: $((ran - failed))/$ran passed$not_run; logs in $out" | tee -a "$summary"
# The refusal control is part of the matrix: not running it is not a pass,
# unless --only left it out on purpose.
[ "$ran" -gt 0 ] && [ "$failed" -eq 0 ] && [ -z "$not_run" ]
