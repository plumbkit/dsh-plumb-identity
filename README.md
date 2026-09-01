# dsh-plumb-identity

Per-agent plumb session identity for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A [cordis](https://github.com/cordisjs/cordis) plugin that gives every DSH conversation, workspace, and in-process subagent its own stable [plumb](https://github.com/plumbkit/plumb) session identity — enforced at the transport layer, not by instruction. Developed and tested against `@deepseek-ai/dsh@0.1.1-rc.2` and plumb `0.17.x`.

## Why

DSH multiplexes every conversation over **one** `plumb serve` connection per process, and DSH's MCP client (`@deepseek-ai/dsh-mcp-client`) sends no identity: no per-conversation session id, no per-call `_meta`. plumb's isolation layer — per-agent workspace shards, read tracking, mail addressing — arms on a *declared* identity, so unidentified conversations can force-re-pin each other's workspaces. The usual mitigation is an instruction in `~/.dsh/AGENTS.md` asking each conversation to declare a `session_id`; that covers main conversations, but DSH subagents run in-process with their own system prompt and no parent context, so they are structurally anonymous.

plumb accepts an agent identity on two channels, both used here:

- `session_start { session_id, workspace, purpose }` — declares the agent, pins its own workspace shard, and records the linkage (stable ids inherit plumb session names across resumes).
- a per-call `tools/call` params `_meta["dev.plumbkit/logical-agent"]` — always honoured by plumb; the fallback that keeps every call attributed even when no declaration has happened yet.

## How it works

1. **Correlate.** A listener on DSH's `tools/execute` waterfall sees every tool call with `exec.agent` — the caller, conversation or subagent, each with its own session UUID and workspace. For `mcp__<serverName>__*` calls it mints a stable id `dsh-<workspace-slug>-<session-short>` and runs the rest of the pipeline inside an `AsyncLocalStorage` scope.
2. **Stamp.** A narrow patch on the MCP SDK `Client.prototype.request` (the exact class instance `dsh-mcp-client` uses, imported by absolute path from DSH's shared profile tree at module load) adds `_meta["dev.plumbkit/logical-agent"]` to `tools/call` requests made inside such a scope. The scope is armed only around plumb tool executions, so a stamped request is by construction a request to the plumb server. The same patch captures the plumb `Client` instance the moment its connection names itself — the stdio transport's server params say `plumb serve` — during the SDK's initial tools sync, long before any agent exists.
3. **Declare.** With the captured instance, the plugin issues a proactive `session_start { session_id, workspace, purpose }` for each agent's first plumb call — outside the identity scope, so the id travels in the arguments where plumb's linkage records it and the shard pins its own workspace. Per-`Client` bookkeeping because `dsh-mcp-client` builds a fresh client on every reconnect generation, and a new connection must re-declare.

Everything fails open: SDK missing, patch refused, declaration rejected — the call proceeds and the AGENTS.md instruction surface remains the fallback. A tool call must never break because its observer could not describe itself.

## Install

Requires a running plumb daemon (`plumb serve` reachable as an MCP server named `plumb` — see `plumb setup dsh`).

### As a profile bundle (recommended)

```sh
dsh plugin --profile web add dsh-plumb-identity
dsh plugin --profile headless add dsh-plumb-identity
```

The package ships a `dsh.bundle` patch, so installing the bundle also mounts the plugin with default config. Restart `dsh` (running processes do not re-read patch layers).

### Manual patch row

If you prefer the user-global patch layer, append to `~/.dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plumb-identity
      name: dsh-plumb-identity
      config:
        serverName: plumb
```

Disable any time by adding `disabled: true` to the row in a later patch layer, or remove the row.

### Local development

Point the row at a checkout instead of the package name:

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

## Interplay notes

- A model that follows `~/.dsh/AGENTS.md` and calls `session_start` with its own id changes nothing: the per-call `_meta` stamp wins plumb's identity resolution, so the conversation stays under its minted id. Keep the AGENTS.md rules — they are the fallback when the plugin is absent and the path through which the model receives plumb's orientation packet.
- A plumb connection keeps ONE session record; `external_id`/`purpose` in `plumb sessions` show the most recent declarer on that connection. Per-agent isolation is plumb's shard state (`pinned_workspace`/`read_tracking` keyed by `logical_agent_id`), not the session record.
- Single-identity connections pin at connection level by design ("one declared id arms nothing"); sharding and per-agent pins engage from the second distinct identity, which is exactly the multi-workspace web case.
- Compatibility is pinned to `@deepseek-ai/dsh@0.1.1-rc.2` field locations (`agent.id`, `agent.session.header.{cwd,parentSession,delegationDepth}`, the `tools/execute` waterfall, SDK `client/index.js`). If a DSH upgrade moves one of these, the plugin fails open loudly in the DSH log; re-run the spike probes to re-map, and please open an issue.

## License

[MIT](LICENSE)
