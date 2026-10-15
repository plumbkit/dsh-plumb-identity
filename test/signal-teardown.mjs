// What the e2e runner does when a signal stops it (^C, or a tool timeout that sends
// SIGTERM): end the dsh runs still in flight, tear down every scenario that has
// not finished (stop its isolated daemon, or release its namespace), then exit
// with the conventional 128 + signal. A SIGKILL cannot be handled; see
// namespace-mode.mjs (`--owner-pid`) and test/container/run.sh for that path.
//
// It is a function of its collaborators so a test can send the signal to a fake
// process and see what is torn down, in what order, and what is said.

import os from 'node:os'

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Install the handler. `environments` is a Map of scenario root -> environment
 * (`teardown()` resolves `{ notes, problems }`), read when the signal arrives;
 * `endGroups()` resolves the problems of ending the dsh process groups. Each
 * signal is handled once. Everything is logged as `  teardown: ...`, which is
 * what test/container/run.sh checks the SIGTERM path for.
 */
export function installSignalTeardown({
  environments,
  endGroups,
  onSignal = () => {},
  proc = process,
  signals = STOP_SIGNALS,
  log = (line) => console.error(line),
  exit = (code) => process.exit(code),
  signalNumber = (name) => os.constants.signals[name],
}) {
  for (const signal of signals) {
    proc.once(signal, () => {
      onSignal(signal)
      log(`\ne2e: ${signal}: tearing down ${environments.size} unfinished scenario(s)`)
      endGroups()
        .then((problems) => problems.forEach((problem) => log(`  teardown: ${problem}`)))
        .catch((error) => log(`  teardown: could not end the dsh runs: ${error.message}`))
        // Read now, not when the signal arrived: a scenario that finished its own
        // teardown meanwhile is not torn down twice.
        .then(() => Promise.all([...environments].map(async ([root, environment]) => {
          try {
            const { notes, problems } = await environment.teardown()
            for (const note of notes) log(`  teardown: ${note}`)
            for (const problem of problems) log(`  teardown: ${problem} (kept: ${root})`)
          } catch (error) {
            log(`  teardown: ${error.message} (kept: ${root})`)
          }
        })))
        .finally(() => exit(128 + signalNumber(signal)))
    })
  }
}
