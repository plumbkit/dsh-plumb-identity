#!/usr/bin/env bash
# Runs the e2e INSIDE the container that test/e2e-container.sh starts (PLAN-526),
# and checks no plumb daemon outlives it. Not meant to be run by hand.
#
# The repo is mounted read-only at /src and copied to /work, so the plugin's own
# dependencies install into a writable tree. While the e2e runs, census.mjs
# samples the plumb daemons every 100 ms; afterwards it rescans for 30 s. Every
# check fails closed: a census that did not run, or a number that cannot be
# read, is a FAIL, never a pass by omission.
#
# Environment (all optional):
#   E2E_EXPECT=pass       (default) every listed scenario must pass
#   E2E_EXPECT=fail       the run must fail the intended way: a non-zero exit
#                         and a line matching E2E_EXPECT_FAIL_MATCH (an extended
#                         regex, required), and no teardown failure
#   E2E_SIGNAL_RUNNER=TERM|KILL and E2E_SIGNAL_AFTER_MS=<ms>
#                         signal the e2e runner mid-run; it must still be
#                         running then, and must exit 143 (TERM: its handler
#                         tears down) or 137 (KILL). KILL is the one path the
#                         e2e cannot clean up: survivors are listed, and the
#                         container's exit ends them (the caller checks the
#                         container is gone)
# In every mode: at most one plumb daemon at a time, at least one seen, and
# none in the 30 s after the run (except after KILL, as above).
# Every other E2E_* variable reaches the e2e unchanged.

set -uo pipefail

expect=${E2E_EXPECT:-pass}
signal=${E2E_SIGNAL_RUNNER:-}
signal_after_ms=${E2E_SIGNAL_AFTER_MS:-20000}
fail_match=${E2E_EXPECT_FAIL_MATCH:-}
case "$expect" in pass|fail) ;; *) echo "run: unknown E2E_EXPECT=$expect" >&2; exit 64 ;; esac
case "$signal" in ''|TERM|KILL) ;; *) echo "run: unknown E2E_SIGNAL_RUNNER=$signal" >&2; exit 64 ;; esac
[[ "$signal_after_ms" =~ ^[0-9]+$ ]] || { echo "run: E2E_SIGNAL_AFTER_MS must be a number of ms" >&2; exit 64; }
if [ "$expect" = fail ] && [ -z "$fail_match" ]; then
  echo "run: E2E_EXPECT=fail needs E2E_EXPECT_FAIL_MATCH, the FAIL line the run must print" >&2
  exit 64
fi
[ -n "$signal" ] && expect=signal

rm -rf /work && mkdir -p /work
tar -C /src --exclude=./node_modules --exclude=./.git --exclude=./.plumb -cf - . | tar -C /work -xf - || exit 70
cd /work || exit 70
if ! npm install --omit=dev --no-audit --no-fund --loglevel=error > /tmp/npm.log 2>&1; then
  cat /tmp/npm.log >&2
  exit 70
fi
echo "run: node $(node -v), dsh $(node -p "require('$DSH_PKG/package.json').version"), mcp sdk $(node -p "require('./node_modules/@modelcontextprotocol/sdk/package.json').version"), $("$PLUMB_BIN" version 2>&1 | grep -m1 '^plumb v')"

# The scenarios this run must pass: the --mode arguments, else every scenario.
expected=()
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = --mode ] && expected+=("${args[$((i + 1))]:-}")
done
if [ ${#expected[@]} -eq 0 ]; then
  mapfile -t expected < <(node test/e2e-mock-provider.mjs --list)
fi
[ ${#expected[@]} -gt 0 ] || { echo "run: no scenarios to expect" >&2; exit 70; }
echo "run: expecting ${#expected[@]} scenario(s): ${expected[*]} (mode $expect${signal:+, SIG$signal after ${signal_after_ms} ms})"

verdict=PASS
problems=()
problem() { verdict=FAIL; problems+=("$1"); }

rm -f /tmp/census.json
node test/container/census.mjs watch /tmp/census.json &
census=$!
sleep 0.3
kill -0 "$census" 2> /dev/null || problem "the census watcher did not start"

node test/e2e-mock-provider.mjs "$@" > >(tee /tmp/e2e.log) 2>&1 &
e2e=$!
signalled=no
if [ -n "$signal" ]; then
  sleep "$(awk "BEGIN { print $signal_after_ms / 1000 }")"
  if kill -0 "$e2e" 2> /dev/null && kill -s "$signal" "$e2e"; then
    signalled=yes
    echo "run: sent SIG$signal to the e2e runner (pid $e2e)"
  else
    problem "the e2e runner had already exited before SIG$signal, so the signal path was not exercised"
  fi
fi
wait "$e2e"
rc=$?
sleep 0.5 # let tee flush

if kill -TERM "$census" 2> /dev/null; then
  wait "$census" || problem "the census watcher exited $?"
else
  problem "the census watcher was not running at the end"
fi
peak=? samples=?
if counts=$(node -e '
  const c = JSON.parse(require("fs").readFileSync("/tmp/census.json", "utf8"))
  if (!Number.isInteger(c.peak) || !Number.isInteger(c.samples)) process.exit(1)
  console.log(c.peak, c.samples)' 2> /dev/null); then
  read -r peak samples <<< "$counts"
fi
if ! [[ "$peak" =~ ^[0-9]+$ && "$samples" =~ ^[0-9]+$ ]]; then
  problem "no readable census (/tmp/census.json)"
else
  [ "$samples" -gt 0 ] || problem "the census took no samples"
  if [ "$peak" -gt 1 ]; then
    problem "$peak plumb daemons at once (at most 1)"
    node -e '
      const c = JSON.parse(require("fs").readFileSync("/tmp/census.json", "utf8"))
      for (const o of c.overlaps) console.log(`run: overlap at ${o.at}: pids ${o.pids.join(", ")}`)
      for (const [pid, d] of Object.entries(c.daemons)) console.log(`run: daemon ${pid} ppid=${d.ppid} home=${d.home} first=${d.first} last=${d.last}`)'
    for f in /tmp/overlap-logs/*; do
      [ -f "$f" ] || continue
      echo "run: daemon.log at the first overlap ($f):"
      grep -E "already running|daemon: ready|did not start|not running — starting|exiting|shutdown|signal" "$f" | tail -20 | sed 's/^/run:   /'
    done
  fi
  [ "$peak" -ge 1 ] || problem "no plumb daemon was ever seen, so the census proves nothing"
fi

if [ "$signal" = KILL ]; then
  # The runner died without teardown, so its dsh, serve and daemon may live on
  # inside this container until the container exits. List them; do not wait.
  node test/container/census.mjs rescan 2000
  echo "run: after the runner's SIGKILL the processes above are ended by the container's exit"
  after=skipped
else
  node test/container/census.mjs rescan 30000 | tee /tmp/rescan.out
  rescan_rc=${PIPESTATUS[0]}
  # Exit 0 counts as clean only with the summary line proving the scan ran.
  if [ "$rescan_rc" -eq 0 ] && ! grep -Eq '^census: rescan 30000 ms, [1-9][0-9]* samples, 0 daemon\(s\) seen$' /tmp/rescan.out; then rescan_rc=2; fi
  case $rescan_rc in
    0) after=0 ;;
    1) after=survivors; problem "a plumb daemon was seen in the 30 s after the run" ;;
    *) after=unknown; problem "the 30 s rescan could not observe the processes" ;;
  esac
fi

case "$expect" in
  pass)
    [ "$rc" -eq 0 ] || problem "e2e exit $rc"
    for mode in "${expected[@]}"; do
      grep -qx "  PASS $mode" /tmp/e2e.log || problem "scenario $mode did not pass"
    done
    grep -q "^  FAIL " /tmp/e2e.log && problem "a FAIL line was printed"
    grep -qx "e2e: all ${#expected[@]} scenario(s) passed" /tmp/e2e.log || problem "no 'all ${#expected[@]} scenario(s) passed' line"
    ;;
  fail)
    [ "$rc" -ne 0 ] || problem "the e2e exited 0, so the failure path was not exercised"
    grep -Eq "$fail_match" /tmp/e2e.log || problem "no line matching /$fail_match/, so the intended failure did not happen"
    grep -q "^  FAIL [^:]*: teardown:" /tmp/e2e.log && problem "teardown failed"
    ;;
  signal)
    if [ "$signalled" = yes ]; then
      want=$([ "$signal" = TERM ] && echo 143 || echo 137)
      [ "$rc" -eq "$want" ] || problem "the e2e exited $rc after SIG$signal, not $want"
    fi
    # The handler must end dsh's process groups and stop the daemon cleanly:
    # any teardown line other than a successful stop is a problem it reported.
    if [ "$signal" = TERM ]; then
      grep "^  teardown: " /tmp/e2e.log | grep -vq "^  teardown: stopped the isolated plumb daemon (pid " && problem "the signal handler's teardown reported a problem"
      grep -q "^  FAIL [^:]*: teardown:" /tmp/e2e.log && problem "a scenario's teardown failed"
    fi
    ;;
esac

for p in ${problems[@]+"${problems[@]}"}; do echo "run: problem: $p"; done
forked=$(node -p 'require("/tmp/census.json").forkedSamples ?? "?"' 2> /dev/null || echo "?")
# A daemon's pre-exec children are excluded from the count (census.mjs says
# why); how often they were seen is reported, so the exclusion is visible.
echo "run: samples that saw a daemon's forked pre-exec child (not counted as a daemon): $forked"
echo "run: verdict=$verdict mode=$expect e2e_exit=$rc peak_daemons=$peak census_samples=$samples after_30s=$after"
[ "$verdict" = PASS ]
