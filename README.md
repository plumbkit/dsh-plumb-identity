# dsh-plumb-identity

Per-agent plumb session identity for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A [cordis](https://github.com/cordisjs/cordis) plugin that gives every DSH conversation, workspace, and in-process subagent its own stable [plumb](https://github.com/plumbkit/plumb) session identity — enforced at the transport layer, not by instruction. Developed and tested against `@deepseek-ai/dsh@0.1.1-rc.2` and plumb `0.17.x`; its field locations were re-verified by inspection on 2026-09-16 against `@deepseek-ai/dsh@0.1.5-rc.1` (MCP SDK 1.30.0) — see the compatibility note at the end for exactly what that does and does not claim.

## Why

DSH multiplexes every conversation over **one** `plumb serve` connection per process, and DSH's MCP client (`@deepseek-ai/dsh-mcp-client`) sends no identity: no per-conversation session id, no per-call `_meta`. plumb's isolation layer — per-agent workspace shards, read tracking, mail addressing — arms on a *declared* identity, so unidentified conversations can force-re-pin each other's workspaces. The usual mitigation is an instruction in `~/.dsh/AGENTS.md` asking each conversation to declare a `session_id`; that covers main conversations, but DSH subagents run in-process with their own system prompt and no parent context, so they are structurally anonymous.

plumb accepts an agent identity on two channels, both used here:

- `session_start { session_id, workspace, purpose }` — declares the agent, pins its own workspace shard, and records the linkage (stable ids inherit plumb session names across resumes).
- a per-call `tools/call` params `_meta["dev.plumbkit/logical-agent"]` — always honoured by plumb; the fallback that keeps every call attributed even when no declaration has happened yet.

## How it works

1. **Correlate.** A listener on DSH's `tools/execute` waterfall sees every tool call with `exec.agent` — the caller, conversation or subagent, each with its own session UUID and workspace. For `mcp__<serverName>__*` calls it mints a stable id `dsh-<workspace-slug>-<session-short>` and runs the rest of the pipeline inside an `AsyncLocalStorage` scope.
2. **Stamp.** A narrow patch on the MCP SDK `Client.prototype.request` (the exact class instance `dsh-mcp-client` uses, imported by absolute path from DSH's shared profile tree at module load) adds `_meta["dev.plumbkit/logical-agent"]` to `tools/call` requests made inside such a scope. The scope is armed only around plumb tool executions, so a stamped request is by construction a request to the plumb server. The same patch captures the plumb `Client` instance the moment its connection names itself — the stdio transport's server params say `plumb serve` — during the SDK's initial tools sync, long before any agent exists.
3. **Declare.** With the captured instance, the plugin issues a proactive `session_start { session_id, workspace, purpose, mail: "preview" }` for each agent's first plumb call — outside the identity scope, so the id travels in the arguments where plumb's linkage records it and the shard pins its own workspace. Per-`Client` bookkeeping because `dsh-mcp-client` builds a fresh client on every reconnect generation, and a new connection must re-declare. `mail: "preview"` matters because this call is automatic and DSH never shows its orientation packet to the model: under plumb's default (`"claim"`) the packet would consume every waiting note unseen. See the interplay notes for plumb < 0.24.

Everything fails open: SDK missing, patch refused, declaration rejected — the call proceeds and the AGENTS.md instruction surface remains the fallback. A tool call must never break because its observer could not describe itself. Failing open is not the same as failing silently, though: a failure that would leave calls unstamped is reported once in the DSH log, because the alternative is a plugin that looks installed and healthy while plumb refuses every write it cannot attribute.

## Install

Requires a running plumb daemon (`plumb serve` reachable as an MCP server named `plumb` — see `plumb setup dsh`).

### As a profile bundle (recommended)

```sh
dsh plugin --profile web add dsh-plumb-identity
dsh plugin --profile headless add dsh-plumb-identity
```

The package ships a `dsh.bundle` patch, so installing the bundle also mounts the plugin with default config. Restart `dsh` (running processes do not re-read patch layers).

> **Pick one mount mechanism.** Installing the bundle *and* keeping a manual `insert` row with the same id crashes DSH at boot — `duplicate loader entry id: dsh-plumb-identity`. Patch layers merge config overrides by row id, but two inserts never merge. If you switch between the two, remove the other first (`dsh plugin --profile <name> remove dsh-plumb-identity`, or delete the row).

### Manual patch row (alternative to the bundle)

Only if the bundle is **not** installed — append to `~/.dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plumb-identity
      name: dsh-plumb-identity
      config:
        serverName: plumb
```

Remove the row, or disable it with an override row at the TOP LEVEL of any patch layer loaded after the one that mounts it (never inside an `insert` list — that would insert a nameless row):

```yaml
- id: dsh-plumb-identity
  disabled: true
```

### Local development

Point the row at a checkout instead of the package name — and remove or disable the bundle mount first, per the warning above:

```yaml
- insert:
    - id: dsh-plumb-identity
      name: 'file:///absolute/path/to/dsh-plumb-identity/dsh-plumb-identity.mjs'
      config: { serverName: plumb, logEvents: true }
```

## Config (all optional)

| field             | default              | meaning                                                                        |
| ----------------- | -------------------- | ------------------------------------------------------------------------------ |
| `serverName`      | `plumb`              | which MCP server's tools to guard (`mcp__<serverName>__*`)                     |
| `idPrefix`        | `dsh`                | first segment of minted ids                                                    |
| `purpose`         | `dsh`                | `session_start` purpose tag for conversations                                  |
| `subagentPurpose` | `dsh-subagent`       | purpose tag when the session header shows `parentSession`/`delegationDepth`    |
| `detail`          | `brief`              | orientation packet size for the proactive `session_start`                      |
| `excludeEnv`      | `["PAUTA_RUN_ID"]`   | skip entirely when any of these env vars is set                                |
| `connectMarker`   | `plumb`              | substring matched against the stdio command to recognise the plumb connection  |
| `logEvents`       | `false`              | per-call stamp/capture debug lines                                             |
| `sdkPath`         | DSH profile tree     | absolute path to the MCP SDK's `client/index.js` (non-standard installs)       |

`excludeEnv` matters: pauta's dsh driver appends its own plumb linkage sentence (`pauta-dsh-<card>-<run>`), and a second identity for the same run would be noise.

**Know what the exclusion costs.** An excluded run mounts nothing, so its plumb calls carry no identity at all. On a shared connection those anonymous calls resolve against the CONNECTION's pin, and a pin such a run sets is what seeds every other agent's shard — so a pauta run can leave a DSH conversation seeded on another workspace. Two things bound the damage: plumb refuses anonymous state-changing calls once two identities have been seen on the connection, and (since 2026-09-16 in plumb `main`) an agent whose declaration is refused is *gated* — its path-bearing calls are refused by name with the `force: true` remedy instead of quietly resolving into the seeded root. If you would rather the pauta run be attributed by this plugin, remove `PAUTA_RUN_ID` here and have the driver pass its run id through the same channels — but verify the driver's contract first; the blanket exclusion is deliberate, not an oversight.

## Verify

```sh
# identities and their workspaces, per agent
sqlite3 "file:$HOME/Library/Application Support/plumb/session_state.db?mode=ro" \
  "SELECT logical_agent_id, workspace, source FROM pinned_workspace WHERE logical_agent_id != '';"

# declared sessions (external_id = minted id, purpose = dsh / dsh-subagent)
ls -t "$HOME/Library/Application Support/plumb/sessions/" | head
```

With two conversations in two workspaces plus a subagent you should see ≥3 distinct `logical_agent_id`s, each pinned to its own workspace, and no pin-contest notices in the daemon log. `plumb sessions` and the `workspace_sessions` tool show the same picture live.

## Tests

```sh
npm test
```

Hermetic — no DSH, no plumb, no network (the MCP SDK is a stub fixture). `spike/probe.mjs` and `spike/observe.mjs` are the field diagnostics: mount either through a `--patch` overlay into a `dsh --profile headless` run to re-map DSH internals after an upgrade.

### End-to-end against a fake model

```sh
npm run test:e2e
```

Verifies the full chain — real DSH agent loop, this plugin mounted from the working tree, real plumb — with only the MODEL scripted (`test/fake-model.mjs`, a local OpenAI-compatible server), so it spends **zero LLM credits** and touches no network beyond localhost. Each scenario runs in a throwaway `DSH_HOME` whose only configured provider is the local fake (a misrouted model request fails on "unknown provider" rather than billing a real key) against an isolated `plumb serve` whose `HOME`/`XDG` roots live under the scenario's temp dir — neither your DSH profile nor your plumb state is touched.

Six scenarios:

- `tool-call` — one plumb tool call; a session with `purpose: dsh` and `external_id: dsh-*` must be declared.
- `text-only` — no plumb tool call; nothing may be declared (the control).
- `subagent` — the agent delegates a subagent that makes the plumb call; a `purpose: dsh-subagent` identity must be declared.
- `per-agent` — the agent and a subagent both call plumb; each must get its own connection, declared on itself, and the shared connection must carry no declaration.
- `mail` — a note is left for "whoever attaches next" before the agent's first plumb call; the model must receive it from `check_messages` exactly once. This is the regression test for the automatic `session_start` consuming mail. Remove `mail: "preview"` from the plugin and it fails with "claimed where the model cannot see it".
- `reconnect` — a note is sent to the agent WHILE it is connected, its own connection then idle-closes (an 8 s `idleMs`; the fake model is held between its two calls until plumb records the end), and the model's `check_messages` runs over a new connection. The note must arrive exactly once and the agent's declared session id must not change. The red control is `E2E_RESUME_PROOF=0 node test/e2e-mock-provider.mjs --mode reconnect`, which mounts the plugin with `resumeProof: false` and must FAIL with the note "stranded on session …" and a second session id.
- `declared-id` — the `reconnect` steps plus a `session_start` the MODEL declares with a `session_id` and `workspace` of its own, which is what the brief tells a DSH agent to do. Exactly one linkage must survive: no record may carry the typed id, no connection may be marked `shared_connection_detected`, the daemon must not log a shared connection, and the note must still arrive exactly once with the session id unchanged. The red control is `E2E_NORMALISE=0 node test/e2e-mock-provider.mjs --mode declared-id`, which mounts the plugin with `normaliseDeclarations: false` and must FAIL with "the daemon reported a shared connection".
- `declared-id-fallback` — the same takeover on the SHARED connection (`perAgentConnection: false`), where the reconnect assertions do not apply. `prepareCall` normalises for both dispatch paths and the unit test only proves the arguments object is rewritten, so this scenario pins that real DSH sends the rewritten object down that path: no record may carry the typed id, no connection may be marked shared, and the daemon must not log a shared connection. The red control is `E2E_NORMALISE=0 node test/e2e-mock-provider.mjs --mode declared-id-fallback`, which must FAIL with "marked 1 connection(s) shared_connection_detected".

The first four assert on plumb's own session records; `mail` asserts on the tool results the fake model was actually sent, and `reconnect` and `declared-id` on both. Every scenario tears down on the way out, on pass and on fail: it ends dsh's process group (so no `plumb serve` is left to redial and start a new daemon), then stops its own isolated plumb daemon, found by the pidfile under its temp `HOME` (never a process-wide sweep). `ps` only vetoes a pid when it can answer, so a sandbox that denies `ps` cannot hide the daemon. The scenario fails, and keeps its temp dir, unless teardown can show the daemon is gone. 2 s after the stop, no plumb socket under the temp `HOME` may still have a listener. Every pidfile there must be readable, and none may name a live process unless `ps` identified that process as something else. A SIGINT, SIGTERM or SIGHUP to the runner (^C, or a tool timeout that sends SIGTERM) runs the same teardown for the scenario in flight. A SIGKILL cannot: it leaves dsh, its serve and the daemon running, and they have to be stopped by hand. The teardown has its own unit tests in `test/isolated-daemon.test.mjs`, run by `npm test`.

Each scenario starts a second plumb daemon, so run the suite in CI, a container or a VM, not on a machine whose own plumb daemon you are using.

Requirements: a `dsh` install (resolved from `$DSH_BIN`, else the `$DSH_HOME` / `~/.dsh` profile tree, exactly what dsh itself resolves) and a plumb binary (`$PLUMB_BIN`, else `../plumb/plumb` beside this checkout, else `plumb` on PATH). Run one scenario with `node test/e2e-mock-provider.mjs --mode subagent`; keep the temp dirs for debugging with `--keep` or `E2E_KEEP=1`.

## Per-agent connections (default)

The plugin no longer only stamps identity onto the connection DSH shares between
agents: for each agent it opens its **own** `plumb serve`, declares that agent on
it, and dispatches the agent's `mcp__plumb__*` calls over it. The connection
carries the identity, so nothing needs stamping and two agents cannot be
confused for each other.

- The shared connection stays for tool discovery and resource reads; only
  execution moves.
- It falls back to the shared path only BEFORE a call is dispatched (no
  connection could be opened, or the per-agent server does not advertise that
  name). A call that has been sent is never re-sent elsewhere — plumb's writes
  are not idempotent, so a "retry" could apply one twice.
- `perAgentConnection: false` restores the stamping-only behaviour.
- `plumbCommand`, else `$PLUMB_BIN`, else `plumb` on PATH selects the binary.
- `idleMs` (default 15 s) closes a connection that has gone unused. It is also
  the only teardown DSH performs: its headless path never disposes plugins, so
  without an idle close the host process outlives the run that finished. A
  connection with a call IN FLIGHT is never closed: the timer is cleared at
  dispatch and armed again when the call settles, so a build, a test run, a slow
  push or a long `check_messages` wait cannot be killed by it (PLAN-516).
- `resumeProof` (default `true`) lets a reconnect after an idle close resume
  the agent's SAME plumb session, so mail bound to it survives (below).
- `resumeProofTimeoutMs` (default 5 s) bounds the hook that computes the proof;
  a value that is not a positive number falls back to the default.
- `normaliseDeclarations` (default `true`) takes over a `session_start` whose
  arguments name a linkage of the model's own, so a connection carries exactly
  ONE (below). `false` passes the model's id through verbatim, without the
  connection's resume proof — the e2e red control, and an escape hatch.
- `PLUMB_IDENTITY_DEBUG=1` traces the connection lifecycle to stderr.

### Reconnects keep the plumb session (resume proof)

Every idle close means the agent's next plumb call opens a new `plumb serve`,
and plumb gives a new connection a new session id unless the serve can resume
the old one. Before 0.3.0 it could not: the agent kept its plumb NAME, got a
new session id on every reconnect (17 in 96 minutes, measured), and a note
bound to the old id while it was connected was left to expire unread.

plumb already has the mechanism: a serve keeps a resume credential per
conversation and presents it when a replacement serve names the same
conversation, and the daemon restores the session, its id, its threads and its
mail. It presents only for a conversation the user's own tooling provably
named: the `session_start` carries the identity stamp and `plumb_hook_proof`,
an HMAC of the stamp under a per-user key the model never sees. So on every
per-agent connect the plugin runs plumb's own identity hook,
`plumb hooks run-claude` (the command Claude Code runs before each plumb call),
for the agent's id, and adds exactly two fields from its answer to the
declaration: the stamp and the proof. The key, its location, its creation, and
whether the running daemon takes a proof all stay plumb's business; the plugin
depends only on names (the hook verb, its input/output shape, the
`mcp__plumb__` prefix, the stamp and proof argument keys), and a renamed one
makes it fail open, not misbehave. The proof is not weakened: the serve still
verifies it against the key.

plumb resumes a session whose previous connection has ENDED. The idle close
ends it before the agent's next call can open another, so the ordinary
reconnect resumes (the `reconnect` e2e waits for plumb to record that end
before the model's next call). A connection opened while the old one is still
live is not resumed and gets a new session, as before.

It fails open. If the hook gives no proof (a plumb that predates it, a daemon
that does not take it, no answer within `resumeProofTimeoutMs`, default 5 s),
the declaration goes out as before and the plugin warns once per process that
reconnects resume by name only. `PLUMB_IDENTITY_HOOK=off`, Claude Code's switch
for that hook, is not passed to it: here it is asked for a proof, not to stamp
a model's call. The shared-connection fallback never sends a proof: one serve
carries many agents there, and its credential is not any one agent's.

### One linkage per connection (a declared id is taken over)

`~/.dsh/AGENTS.md` tells every DSH conversation to declare a `session_id`, and a
model that follows it calls `session_start` with an id of its own. That is a
SECOND linkage on a connection that already carries the plugin's proven one, and
plumb's rules for it are strict: an unstamped `session_start` naming another
linkage hands the connection over — `SaveIdentity` replaces the identity row's
`external_id`, which **revokes the resume credential** hanging on it — and two
logical agents on one serve make it a *shared connection*, where an
unattributable state-changing call is refused.

Measured live on 2026-10-11, before this was handled: the agent's declaration
arrived 79 ms after the plugin's, the credential was revoked 48 ms later, and
every reconnect after that resumed by name only — seven session ids in seven
minutes, the note bound to each one stranded, and `check_messages`/`git` refused
on the connection that carried both ids.

So the plugin takes the id over, exactly as Claude Code's identity hook does
(`plumb/internal/cli/hooks_claude_identity.go`): a `session_id` the model typed
is replaced with the connection's proven id, a stamp or `plumb_hook_proof` it
typed is dropped, and everything else it asked for — `workspace` (an intentional
re-pin), `purpose`, `detail`, `mail` — is passed through untouched. The takeover
is reported once per agent in the DSH log, naming both ids.

The per-agent connection also carries the resume proof on that declaration —
when it names the connection's own id, which with normalisation on it always
does: if the opening declaration could not be proved, this is the second chance
to link the conversation to a credential. A declaration the plugin did NOT take
over (`normaliseDeclarations: false`) goes out verbatim instead: no rewrite, no
stamp, no proof — which is also the shape a live DSH agent sends. The
shared-connection fallback keeps its declaration unproved, here and everywhere:
one serve carries many conversations, and plumb's `claim()` lets a serve process
link exactly ONE conversation for its whole life, so proving there would bar
every other agent on that connection and file a credential it could never
present.

## Interplay notes

- A model that follows `~/.dsh/AGENTS.md` and calls `session_start` with its own id is handled, not obeyed: the plugin rewrites that id to the connection's proven one (above). Before that takeover it was neither harmless nor obeyed — on a per-agent connection the call is dispatched outside the identity scope, so the per-call `_meta` stamp is NOT on it and plumb read the typed id as a second linkage, revoking the resume credential and stranding bound mail. Keep the AGENTS.md rules: they are the fallback when the plugin is absent and the path through which the model receives plumb's orientation packet.
- A plumb connection keeps ONE session record; `external_id`/`purpose` in `plumb sessions` show the most recent declarer on that connection. Per-agent isolation is plumb's shard state (`pinned_workspace`/`read_tracking` keyed by `logical_agent_id`), not the session record.
- Single-identity connections pin at connection level by design ("one declared id arms nothing"); sharding and per-agent pins engage from the second distinct identity, which is exactly the multi-workspace web case.
- **The automatic `session_start` previews mail; it must never claim it.** plumb's `session_start` defaults to `mail: "claim"`, which delivers waiting notes exactly once, into its orientation packet. DSH consumes that packet without showing it to the model, so a claim there loses the note: it is gone from `check_messages` before the model can ask. The plugin therefore sends `mail: "preview"` (plumb >= 0.24.0) on both declaration paths. **plumb < 0.24** doesn't know the argument, and its argument guard refuses the whole call with `session_start: unknown parameter "mail"`. On exactly that refusal the plugin re-sends the declaration once without `mail`, remembers it for that client, and warns once that mail is being claimed again. Upgrading plumb is the fix. Any other refusal is handled as below.
- **A refused declaration is a failure, not a success.** plumb answers a refused `session_start` with an ordinary tool RESULT carrying `isError: true` — not a transport error — so a `try/catch` sees success. This plugin inspects the result, and lets plumb's own scope decide the recovery: `details.scope = "agent"` means `force: true` moves only this agent's shard, so it retries once with force; `details.scope = "connection"` means force would move the pin every agent on the connection resolves against, so it is reported and never forced automatically. Concurrent first calls from one agent share a single in-flight declaration. On a per-agent connection a refused declaration is reported in the DSH log too (before 0.2.0 it was silently ignored there); nothing else shares that connection, so it is never forced.
- Compatibility is pinned to `@deepseek-ai/dsh@0.1.1-rc.2` field locations (`agent.id`, `agent.session.header.{cwd,parentSession,delegationDepth}`, the `tools/execute` waterfall, SDK `client/index.js`). On 2026-09-16 those were re-verified by inspection against `@deepseek-ai/dsh@0.1.5-rc.1` with MCP SDK 1.30.0: live DSH conversations still appear in plumb's `pinned_workspace` rows under this plugin's minted ids, and the SDK's `ResultSchema` is a `z.looseObject` with `_meta` declared, so the failure envelope this plugin reads (`_meta["dev.plumbkit/error"]`) survives parsing. The spike probes were **not** re-run for 0.1.5-rc.1 and the tested target has not been bumped — treat 0.1.1-rc.2 as tested and 0.1.5-rc.1 as observed-working. If a DSH upgrade moves one of these, the plugin fails open and **reports it** in the DSH log; re-run the spike probes to re-map, and please open an issue.
- **2026-10-01 — the stamp patch can be installed and inert, which is invisible unless it is reported.** `@deepseek-ai/dsh@0.2.0-rc.2`'s `dsh-mcp-client` depends on `@modelcontextprotocol/client@2.0.0`, while this plugin patches `@modelcontextprotocol/sdk` (1.30.0) from `${DSH_HOME}/profiles/node_modules/…` — a path that resolves through a symlink into the npx cache generation of an *earlier* launch. The import succeeded, the patch installed on a class nothing instantiates, and no warning fired, because the only check was whether the import threw. The symptom was plumb refusing every state-changing call as unattributed, with nothing on the client side to explain it. The plugin now counts routed plumb calls against applied stamps and warns once per apply when a call completes with nothing stamped, naming the path it patched. Two structural follow-ups remain: resolve the MCP package from the running DSH's own module tree rather than a fixed profile path (`npx` mints a new generation directory per launch), and port the patch to `@modelcontextprotocol/client@2.0.0`.

## License

[MIT](LICENSE)
