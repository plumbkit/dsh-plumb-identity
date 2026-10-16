// Preloaded (node --import) by host-namespace-e2e.test.mjs: at exit, records how many
// handlers the process holds for the signals the e2e's teardown handles, so the test
// can tell a run that installed its handler from one refused before it did. It adds
// no signal listener of its own.
import fs from 'node:fs'

process.on('exit', () => {
  try {
    fs.writeFileSync(process.env.LISTENER_PROBE_OUT, JSON.stringify(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))))
  } catch {
    // The test reads a missing file as "the probe never wrote".
  }
})
