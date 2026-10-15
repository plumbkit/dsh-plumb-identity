#!/usr/bin/env bash
# Run the e2e in a Docker container (PLAN-526). The e2e drives a plumb daemon (in
# the default isolation the one daemon test/container/run.sh starts, with a plumb
# namespace per scenario; with E2E_ISOLATION=daemon, a daemon per scenario), and a
# developer machine's one daemon is not a test's, so it refuses to run there; this
# is where it runs instead.
#
#   test/e2e-container.sh --plumb <linux plumb binary> [e2e args...]
#
# The plumb binary must be built for the container's Linux and CPU, e.g. from a
# plumb checkout:  GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o /tmp/plumb-linux ./cmd/plumb
# (GOARCH=amd64 on an Intel host). E2E_EXPECT, E2E_SIGNAL_RUNNER and the e2e's
# own E2E_* variables pass through; see test/container/run.sh.
#
# The container runs with --init, so exited processes are reaped rather than
# counted as live, and --rm, so its exit ends every process it started: that is
# also what covers a SIGKILL'd runner, which no in-process teardown can.

set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_version=${DSH_VERSION:-0.2.0-rc.2}
plumb=
usage() {
  echo "usage: test/e2e-container.sh --plumb <linux plumb binary> [e2e args...]" >&2
  exit 64
}
while [ $# -gt 0 ]; do
  case "$1" in
    --plumb) [ $# -ge 2 ] || usage; plumb=$2; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ -n "$plumb" ] && [ -f "$plumb" ] || usage
if [ "$(head -c 4 "$plumb" | od -An -c | tr -d ' ')" != '177ELF' ]; then
  echo "e2e-container: $plumb is not a Linux (ELF) binary" >&2
  exit 64
fi
plumb=$(cd "$(dirname "$plumb")" && pwd)/$(basename "$plumb")

image=dsh-plumb-identity-e2e:dsh-$dsh_version
docker build -q -t "$image" --build-arg "DSH_VERSION=$dsh_version" "$repo/test/container" > /dev/null || exit 70

name=dsh-identity-e2e-$(date +%s)-$$
# A signal kills the container but does not exit: the run still ends with the
# engine's answer on whether the container is gone, and then fails.
interrupted=0
trap 'interrupted=1; docker kill "$name" > /dev/null 2>&1' INT TERM HUP

envs=()
while IFS='=' read -r key _; do
  case "$key" in E2E_*) envs+=(-e "$key") ;; esac
done < <(env)

# In the background and waited for, so the trap above can run while it does
# (bash defers traps until a foreground command returns).
docker run --rm --init --name "$name" \
  -v "$repo:/src:ro" -v "$plumb:/opt/plumb/plumb:ro" \
  ${envs[@]+"${envs[@]}"} "$image" bash /src/test/container/run.sh "$@" &
child=$!
wait "$child"
rc=$?
# A signal interrupts the first wait; wait again for docker run to finish.
kill -0 "$child" 2> /dev/null && { wait "$child"; rc=$?; }
[ "$interrupted" -eq 1 ] && { echo "e2e-container: interrupted" >&2; rc=130; }

# Container exit is what ends a SIGKILL'd run's processes, so "gone" must be
# an answer from the engine, never the failure to get one.
if ! listed=$(docker ps -a --filter "name=^/$name\$" --format '{{.Names}}'); then
  echo "e2e-container: could not ask docker whether container $name is gone" >&2
  rc=1
elif [ -n "$listed" ]; then
  echo "e2e-container: container $name still exists" >&2
  rc=1
else
  echo "e2e-container: container $name is gone, so every process it started has ended"
fi
exit $rc
