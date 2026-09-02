// A scripted stand-in for the MODEL layer only: a local HTTP server speaking
// just enough of the OpenAI chat-completions API (streaming and non-streaming)
// to drive DSH's real agent loop through a deterministic scenario. Real DSH,
// real plugins, real plumb — no LLM provider and no credits.
//
// Responses are decided by CONTENT, never by request count, so tool-result
// turns, title generation and subagent traffic all resolve to plain text no
// matter what order they arrive in:
//
//   - `tool-call`  (default) — the first request that carries no tool result
//     yet gets a tool_call for the plumb info tool; every later request gets
//     text "done".
//   - `text-only` — never calls a tool; the control scenario asserting the
//     identity plugin declares nothing without a plumb tool call.
//   - `subagent` — the first request gets a call for DSH's `subagent` tool
//     (capped at one spawn, so the delegated child cannot recurse); the child
//     then takes the plumb tool_call the same way the tool-call scenario does.
//
// The tool to call is read from the request's own `tools[]` (matched by name
// shape, never hardcoded), and arguments are filled generically from the
// tool's declared schema, so upstream renames of MCP namespacing degrade into
// a loud scenario failure instead of a silently wrong test.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The instruction the fake fills into delegated/spawned prompts. */
const CANNED_TASK = 'Use the mcp__plumb__daemon_info tool once, then reply with exactly: done'

/** The text answer for every non-tool-call turn. */
const FINAL_TEXT = 'done'

/** Plausible non-zero usage: dsh's token meter reads these fields. */
const USAGE = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }

export const FAKE_MODEL_MODES = ['tool-call', 'text-only', 'subagent']

/**
 * Start the fake model on an ephemeral 127.0.0.1 port.
 * @param {{mode?: string, log?: (line: string) => void}} options
 * @returns {Promise<{url: string, port: number, requests: string[], close: () => Promise<void>}>}
 */
export function createFakeModel({ mode = 'tool-call', log = () => {} } = {}) {
  if (!FAKE_MODEL_MODES.includes(mode)) {
    throw new Error(`fake-model: unknown mode "${mode}" (expected one of ${FAKE_MODEL_MODES.join(', ')})`)
  }
  const state = { spawns: 0, requests: [] }
  const server = http.createServer((req, res) => {
    collectBody(req)
      .then((body) => route(req, res, body, mode, state, log))
      .catch((error) => sendJson(res, 500, { error: { message: `fake-model: ${error.message}` } }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        requests: state.requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** Standalone debugging: FAKE_MODEL_MODE=subagent node test/fake-model.mjs */
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const mode = process.env.FAKE_MODEL_MODE ?? 'tool-call'
  const model = await createFakeModel({ mode, log: (line) => console.log(line) })
  console.log(`fake-model (${mode}) listening on ${model.url} — ctrl-c to stop`)
}

// -- routing ------------------------------------------------------------------

function route(req, res, body, mode, state, log) {
  if (req.method === 'GET' && /\/models\/?$/.test(req.url ?? '')) {
    return sendJson(res, 200, { object: 'list', data: [] })
  }
  if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url ?? '')) {
    return sendJson(res, 404, { error: { message: `fake-model: no route for ${req.method} ${req.url}` } })
  }
  let parsed
  try {
    parsed = JSON.parse(body || '{}')
  } catch (error) {
    return sendJson(res, 400, { error: { message: `fake-model: invalid JSON body: ${error.message}` } })
  }
  const line = summarize(parsed)
  state.requests.push(line)
  log(`fake-model <- ${line}`)
  return respond(res, parsed, mode, state)
}

function respond(res, parsed, mode, state) {
  const decision = decide(parsed, mode, state)
  const model = typeof parsed.model === 'string' ? parsed.model : 'fake-1'
  const wantsUsage = parsed.stream_options?.include_usage === true
  if (parsed.stream === true) {
    return sendSse(res, streamChunks(decision, model, wantsUsage))
  }
  return sendJson(res, 200, completionBody(decision, model))
}

/**
 * Pick the response from the request's shape. Content-based, never
 * count-based: a request whose conversation already carries a tool result is
 * by definition a follow-up turn and gets text.
 */
function decide(parsed, mode, state) {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const hasToolResult = messages.some((message) => message.role === 'tool')
  if (mode === 'text-only' || hasToolResult) return { kind: 'text' }
  const tools = (Array.isArray(parsed.tools) ? parsed.tools : [])
    .map((entry) => entry?.function ?? (typeof entry?.name === 'string' ? entry : null))
    .filter(Boolean)
  if (mode === 'subagent' && state.spawns < 1) {
    const spawn = tools.find((tool) => tool.name === 'subagent' || /\bsubagent\b/i.test(tool.name))
    if (spawn) {
      state.spawns += 1
      return { kind: 'tool', name: spawn.name, args: fillArguments(spawn) }
    }
  }
  const plumb = tools.find((tool) => /daemon_info$/.test(tool.name))
  if (plumb) return { kind: 'tool', name: plumb.name, args: fillArguments(plumb) }
  return { kind: 'text' }
}

/**
 * Fill a tool call's arguments from the tool's declared JSON schema: every
 * required property gets a usable placeholder, and `run_in_background` is
 * forced false when offered so a delegated subagent is awaited within this
 * run instead of outliving it.
 */
function fillArguments(tool) {
  const schema = tool.parameters ?? {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = schema.properties ?? {}
  const args = {}
  for (const name of required) args[name] = placeholder(name, properties[name])
  if ('run_in_background' in properties) args.run_in_background = false
  return args
}

function placeholder(name, property = {}) {
  const type = property.type ?? 'string'
  if (type === 'boolean') return false
  if (type === 'number' || type === 'integer') return 1
  if (type === 'object') return {}
  if (type === 'array') return []
  if (/^desc/i.test(name)) return 'e2e identity probe'
  if (/prompt|message|task|instruction/i.test(name)) return CANNED_TASK
  return 'e2e'
}

// -- wire formats ---------------------------------------------------------------

/** OpenAI streaming format: tool calls arrive as deltas, then a usage tail. */
function streamChunks(decision, model, wantsUsage) {
  const chunk = () => ({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model })
  const chunks = []
  if (decision.kind === 'tool') {
    chunks.push(
      { ...chunk(), choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: decision.name, arguments: '' } }] }, finish_reason: null }] },
      { ...chunk(), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(decision.args) } }] }, finish_reason: null }] },
      { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    )
  } else {
    chunks.push(
      { ...chunk(), choices: [{ index: 0, delta: { role: 'assistant', content: FINAL_TEXT }, finish_reason: null }] },
      { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    )
  }
  if (wantsUsage) chunks.push({ ...chunk(), choices: [], usage: USAGE })
  return chunks
}

function completionBody(decision, model) {
  const message = decision.kind === 'tool'
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_e2e_1', type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.args) } }],
      }
    : { role: 'assistant', content: FINAL_TEXT }
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: decision.kind === 'tool' ? 'tool_calls' : 'stop' }],
    usage: USAGE,
  }
}

// -- small io helpers -------------------------------------------------------------

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendSse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    req.on('data', (part) => parts.push(part))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/** One-line request description for logs — roles, plumb tools, streaming. */
function summarize(parsed) {
  const roles = (Array.isArray(parsed.messages) ? parsed.messages : []).map((message) => message.role).join(',')
  const toolNames = (Array.isArray(parsed.tools) ? parsed.tools : [])
    .map((entry) => entry?.function?.name ?? entry?.name)
    .filter(Boolean)
  const plumb = toolNames.filter((toolName) => toolName.startsWith('mcp__'))
  return `roles=${roles || 'none'} tools=${toolNames.length}${plumb.length ? ` plumb=[${plumb.join(' ')}]` : ''} stream=${parsed.stream === true}`
}
