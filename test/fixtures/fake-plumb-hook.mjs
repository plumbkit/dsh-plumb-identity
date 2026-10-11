#!/usr/bin/env node
// A stand-in for `plumb hooks run-claude` in the hermetic unit tests: it reads
// the PreToolUse event on stdin and answers the way plumb's identity hook does,
// without a daemon or a key. FAKE_PLUMB_HOOK picks the answer:
//
//   proof     (default) the stamp under plumb_agent, plus a proof
//   legacy    the stamp under the older _meta-named key, plus a proof
//   noproof   the stamp but no proof (what the real hook writes for a daemon
//             that takes no proof)
//   silent    nothing on stdout (no daemon answered), a reason on stderr
//   mismatch  a proof for a different session id
//   stall     never answers
//
// FAKE_PLUMB_HOOK_LOG, when set, receives one JSON line per run: the argv, the
// event it read, and whether PLUMB_IDENTITY_HOOK reached it.

import fs from 'node:fs'

let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const event = JSON.parse(input)
  if (process.env.FAKE_PLUMB_HOOK_LOG) {
    fs.appendFileSync(process.env.FAKE_PLUMB_HOOK_LOG, `${JSON.stringify({
      argv: process.argv.slice(2),
      event,
      killSwitch: process.env.PLUMB_IDENTITY_HOOK ?? null
    })}\n`)
  }
  const id = event.session_id
  const answer = (updatedInput) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })}\n`)
  switch (process.env.FAKE_PLUMB_HOOK ?? 'proof') {
    case 'proof':
      answer({ ...event.tool_input, session_id: id, plumb_agent: id, plumb_hook_proof: `proof-of-${id}` })
      break
    case 'legacy':
      answer({ ...event.tool_input, session_id: id, 'dev.plumbkit/logical-agent': id, plumb_hook_proof: `proof-of-${id}` })
      break
    case 'noproof':
      answer({ ...event.tool_input, session_id: id, plumb_agent: id })
      break
    case 'silent':
      process.stderr.write('plumb identity hook: left the call unstamped: reason=fake: no daemon answered\n')
      break
    case 'mismatch':
      answer({ session_id: 'someone-else', plumb_agent: 'someone-else', plumb_hook_proof: 'proof-of-someone-else' })
      break
    case 'stall':
      setInterval(() => {}, 1_000)
      break
  }
})
