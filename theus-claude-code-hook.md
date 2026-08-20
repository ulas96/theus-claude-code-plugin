# Handoff: `@theus` Claude Code Hook — DeepSeek Harness Prompt Wrapping

Status: ready for execution.
Authoring session: 2026-08-20 (repo checkout `/Users/ulas/Documents/Github/deepseek-harness`).
Scope of this document: one mission — a real Claude Code `UserPromptSubmit` hook, triggered by the literal marker `@theus` appearing in a user's prompt, that ensures a long-lived DeepSeek Harness (`dsh`) server is running, routes the prompt through it, and injects the harness's processed output as additional context for the Claude model handling that turn.
All repo facts below were verified against this checkout on the authoring date. Line numbers drift; treat them as pointers and re-grep before relying on one.

## 1. Mission

A person typing `@theus` anywhere in a Claude Code prompt wants that prompt enriched by DeepSeek Harness before Claude answers: dsh's own system prompt, tools, and DeepSeek-backed agent loop run against the (marker-stripped) prompt text, and the resulting text is handed to Claude as grounding context. Claude remains the model that actually answers inside the user's Claude Code session — this feature is a pre-processing enrichment step, not a replacement for Claude.

Deliverable of the work this document specifies: two new npm packages in this monorepo (a daemon and a hook bin), one functional addition to an existing SDK package, one new example composition leaf, and a standalone plugin repository that packages the hook for installation into Claude Code. This handoff itself is not code — it is the specification an implementing agent executes.

## 2. Relationship to prior work — read once, do not carry forward

`.agents/handoffs/2026-08-20-claude-code-plugin-integration.md` designs a different, unrelated feature: an MCP server that surfaces individual DSH tools to Claude while Claude stays the orchestrator. It explicitly evaluates and rejects "a hook that silently routes whole prompts through a DSH/DeepSeek agent loop," citing per-call LLM cost and credential requirements as reasons to prefer the MCP shape as a v1 default.

This handoff specifies exactly the shape that document rejected, on direct instruction from the person who owns this decision: `@theus` must route the *whole* prompt through dsh's *own* agent loop, not expose individual dsh tools for Claude to decide whether to call. Do not use that document as design authority for anything below. It is referenced exactly twice more in this document: once in the required Agent Note's `## Alternatives considered` section (§12), and nowhere else.

## 3. What a real Claude Code `UserPromptSubmit` hook can and cannot do

This is Anthropic's product hook contract, not something this repository defines. `packages/hooks/hooks-claude-code` in this repo is a *faithful replay* of the same wire shapes for an unrelated purpose (dsh replaying an external `hooks.json` onto its own internal extension points) — useful here only as a reference for the exact JSON shapes below, never as infrastructure to build on; that package's own README states its scope is the opposite direction (external hooks.json → dsh internals), which is not this feature.

**Stdin**, one JSON object per invocation:
```json
{
  "session_id": "<claude code session id>",
  "transcript_path": "<path>",
  "cwd": "<the user's working directory in that session>",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "<raw user prompt text, exactly as typed>"
}
```

**Exit code / stdout contract:**
- Exit `2` → the prompt is blocked; stderr becomes the block reason shown to the user. Never use this path for an infrastructure failure (§9) — it would turn an enrichment feature into an outage of the user's real prompt.
- Exit `0`, stdout starting with `{` → parsed as JSON. The field this feature uses:
  ```json
  {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<text>"}}
  ```
  `additionalContext` is added as extra context alongside the original prompt when Claude answers.
- Exit `0`, no stdout, or non-JSON stdout → treated as a no-op pass-through. This is the fail-open path (§9).
- **There is no field that rewrites or replaces the literal prompt text.** `additionalContext` injection is the only mechanism available to get harness-processed content in front of Claude. Do not design around a "replace the prompt" capability — it does not exist in this contract.

**Timeout:** the hook command registration (`hooks.json`, §10) carries a per-hook `timeout` in seconds; Claude Code kills the hook process if it runs longer. A full dsh agentic turn (multiple tool calls, a real DeepSeek request) can take much longer than a typical default hook timeout — the registered `hooks.json` entry must set an explicit, generous `timeout` (§10), and the hook's own internal request timeout (§9) must stay comfortably under it so the hook can fail open cleanly instead of being killed mid-flight.

## 4. Two load-bearing findings from source — read before writing code

### 4.1 A socket transport needs no protocol or server code changes

`packages/sdk/protocol`'s `JsonRpcLineTransport` (`packages/sdk/protocol/src/transport.ts`) is a newline-delimited JSON-RPC 2.0 transport over any `Readable`/`Writable` stream pair — it is not hardcoded to process stdio. `packages/sdk/server`'s exported `HarnessSdkJsonRpcServer` class (`packages/sdk/server/src/server.ts`) is likewise constructed against a transport, not against `process.stdin`/`process.stdout` directly; that binding happens only in the plugin's `apply()` (`packages/sdk/server/src/index.ts`). A `net.Socket` (including a Unix domain socket connection) satisfies both `Readable` and `Writable`, so the daemon (§6.2) can hand a live socket connection straight to `new JsonRpcLineTransport(socket, socket)` and `new HarnessSdkJsonRpcServer(ctx, transport, config)` with no changes to either package.

### 4.2 The existing server plugin's `shutdown` wiring must not be reused verbatim by a multi-connection daemon

Verified directly, `packages/sdk/server/src/index.ts:46-92` (`apply`): the plugin answers the wire `shutdown` RPC by calling `disposeAndExit`, which disposes `ctx.root.fiber` — the *entire* Cordis tree — and then calls `exit(0)`. This is correct and documented for the plugin's actual contract, one client process per server process (`packages/examples/jsonrpc-agent`'s bin owns exactly one stdio pair for exactly one lifetime). It is **wrong** for a daemon serving many independent connections: any one Claude Code session's `shutdown` (or connection-cleanup path that reaches this code) would tear down every other session's live agent along with it.

The daemon must not mount `@deepseek-ai/dsh-sdk-jsonrpc-server`'s `apply()` per connection. Instead, compose `JsonRpcLineTransport` and the exported `HarnessSdkJsonRpcServer` class directly inside the daemon's own per-connection `ctx.plugin()` fork (§6.2). Cordis fibers are multi-instantiable — one call to `ctx.plugin()` per accepted socket connection creates an independent fiber whose disposal is scoped to that fiber alone (`vendor/cordis/src/registry.ts`, fiber-per-`ctx.plugin()`-call semantics). Disposing one connection's fork tears down only that connection's own agents, via `HarnessSdkJsonRpcServer.performShutdown()` (`packages/sdk/server/src/server.ts:390-420`, which already flushes and disposes exactly the `AgentHandle`s that server instance created), leaving the shared `agents`, `llm`, and `sessions` services running for every other live connection.

One composition detail this implies: `HarnessSdkJsonRpcServer.initialize()` mounts `dsh-llm-deepseek` itself only as a fallback, "when unowned" (`server.ts:148-151`). The daemon's `cordis.yml` (§6.4) must mount `dsh-llm-deepseek` statically at the top level — exactly as `examples/jsonrpc-agent/cordis.yml` already does — so no single connection's server instance ever becomes the accidental sole owner of the shared LLM fiber and disposes it out from under every other connection when that one connection closes.

## 5. Architecture overview

```
Claude Code (UserPromptSubmit fires)
  → spawns @deepseek-ai/dsh-theus-hook bin, stdin = hook payload (§3)
      → prompt contains "@theus"? no → exit 0, no stdout (pass through)
      → yes → probe daemon socket (connect attempt)
          → absent → spawn @deepseek-ai/dsh-theus-daemon detached, wait for socket
          → connect, initialize({cwd: payload.cwd, ...}), session/resume(sessionId) [miss OK]
          → session/prompt(sessionId, strippedPromptText) → await session.status idle
          → read finalResponse text
      → print {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext": finalResponse}}
      → exit 0
      → (any failure/timeout at any step above) → swallow, print nothing, exit 0 (§9)

@deepseek-ai/dsh-theus-daemon (long-lived, survives across many hook invocations)
  boots examples/theus-daemon/cordis.yml ONCE: agents, dsh-llm-deepseek, session persistence, tools
  listens on a Unix domain socket
  per accepted connection: mount ctx.plugin(connectionFork) owning one
    JsonRpcLineTransport + HarnessSdkJsonRpcServer pair bound to that socket
  connection close/error → dispose only that connection's fork
  active-connection count reaches 0 and idleTimeoutMs elapses → dispose root, exit 0
```

## 6. New and changed packages

### 6.1 `packages/sdk/client` — socket launch mode (functional change to an existing package)

`packages/README.md` marks `sdk/` "Product — stable API"; keep this diff additive. Extend `HarnessClientOptions` (`packages/sdk/client/src/types.ts`) from a single subprocess-launch shape into a discriminated union:

```ts
export type HarnessLaunchOptions =
  | { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }  // existing, unchanged
  | { socketPath: string }                                                             // new
```

Branch `HarnessClient.start()` (`packages/sdk/client/src/client.ts`) on which variant is present: the existing branch keeps calling `spawn(...)`; the new branch calls `net.createConnection(socketPath)` and waits for the `'connect'` event before proceeding. Branch `performClose()` similarly: the existing subprocess EOF→SIGTERM→SIGKILL ladder is unchanged; the new branch calls `socket.end()` and waits for `'close'`.

Everything downstream of `this.transport`/`this.request()` — `initialize()`, `prompt()`, `subscribe()`, `subscribeSessionTree()`, and `DeepSeekHarness`/`HarnessSession.run()` in `packages/sdk/client/src/api.ts` — needs **no changes**: those only ever go through the transport and the request/notification correlation logic, never the process-specific fields (`stderrTail`, `exitCode`, `spawnError`). This reuse is exactly why `HarnessSession.run()`'s existing correlation loop (send `session/prompt` → wait for the `agent/inbox/spliced` receipt for the returned `messageId` → collect `session.event`s → wait for `session.status: idle` → read the last `assistant/message` event's text via `finalResponse()`) is the mechanism §6.3's hook should call directly, not reimplement.

Update `packages/sdk/client/README.md` and JSDoc on `HarnessClientOptions`/`start()`/`performClose()` in the same change, per this repo's "docs accompany every code change" rule.

### 6.2 `packages/theus/daemon` → `@deepseek-ai/dsh-theus-daemon`

New group `packages/theus/` — not `packages/sdk/*` (whose own README states "this group does not create, configure, build, or launch developer projects," which a socket-listening daemon booting its own Cordis tree does) and not `packages/hooks/*` (whose own README states its packages bridge an *external* hooks.json onto dsh's own internal extension points — the opposite direction from this feature, which is dsh being driven by a real external product hook with no dsh-internal interception involved).

Responsibilities of this package's bin:
1. Resolve the socket path (§7).
2. If the socket path is already in use by a live process (probe by connecting, §7), exit immediately — do not run two daemons.
3. Otherwise, boot `examples/theus-daemon/cordis.yml` (§6.4) once via `@deepseek-ai/dsh-app-boot`'s `boot()`, the same entry point `packages/examples/jsonrpc-demo/src/bin.ts` uses.
4. `net.createServer()` listening on the resolved Unix socket path.
5. On each `'connection'` event: `ctx.plugin(connectionPlugin, { socket })`, where `connectionPlugin` constructs `new JsonRpcLineTransport(socket, socket)` and `new HarnessSdkJsonRpcServer(ctx, transport, config)` per §4.2 — never the packaged `apply()` from `dsh-sdk-jsonrpc-server`. On socket `'close'`/`'error'`, dispose that connection's fiber.
6. Track active-connection count; when it reaches zero, start an `idleTimeoutMs` timer (config field, §7); a new connection before the timer fires cancels it; the timer firing disposes the root fiber and exits 0.
7. `SIGTERM`/`SIGINT` → dispose root fiber, unlink the socket file, exit 0 (mirrors `packages/examples/jsonrpc-demo/src/runner.ts`'s existing signal handling).

Package-level `./invariant` (per `packages/AGENTS.md`, every package owns one): this package owns the socket-connection-count/idle-timer as genuinely mutable, owned state — the invariant check should assert that connection count and disposed-fiber count stay reconciled (no fiber leak across many connect/disconnect cycles), not use a generated empty-installer placeholder.

### 6.3 `packages/theus/hook` → `@deepseek-ai/dsh-theus-hook`

Thin bin, the actual `command` a Claude Code `hooks.json` entry invokes. Responsibilities:
1. Read stdin fully, parse as the `UserPromptSubmit` JSON (§3). Any parse failure → fail open (§9).
2. `prompt.includes('@theus')` — case-sensitive plain substring match, no word-boundary requirement (confirmed decision; a false-positive substring match, e.g. inside an email address, just adds unwanted but harmless context, not a correctness hazard). If absent, exit 0 with no stdout immediately.
3. Strip the first occurrence of the literal substring `@theus` from the prompt text before sending it onward — the routing marker itself is not part of the task for dsh to work on.
4. Resolve the daemon socket path (§7, same resolution the daemon uses) and probe it. If absent, spawn the daemon bin detached and poll-connect within a bounded startup budget.
5. Using the extended `@deepseek-ai/dsh-sdk-client` (§6.1) in socket-launch mode: `initialize({ cwd: payload.cwd, provider, model, ... })` — verify the current default `provider`/`model` identifiers against `packages/llm/*`'s current catalog at implementation time; do not assume the values shown in existing SDK README examples are still current.
6. `request('session/resume', { sessionId: payload.session_id })`, swallowing a "no such session" failure (first-ever `@theus` turn in this Claude Code session) but not swallowing any other failure shape — confirm the exact error discriminant at implementation time so this branch cannot silently mask a genuine daemon or persistence fault (§8).
7. `harness.session(payload.session_id).run(strippedPrompt)`, racing it against an internal timeout (§9).
8. On success: print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext": result.finalResponse}}` to stdout, exit 0.
9. On any failure or timeout at any step 4-8: print nothing to stdout, write a short diagnostic to stderr only, exit 0 (§9) — never exit 2 for an infrastructure failure.

Package-level `./invariant`: this package owns no independent event stream or mutable registry (it is one request-response cycle per process invocation) — a justified empty-installer form, matching `packages/examples/jsonrpc-demo/src/invariant.ts`'s existing "No runtime invariant" pattern, with a package-specific reason stated inline rather than copied verbatim.

### 6.4 `examples/theus-daemon/cordis.yml`

New composition leaf the daemon boots. Start from `examples/jsonrpc-agent/cordis.yml` (verified content: `sdk-jsonrpc-server`, `llm-deepseek`, `subprocess`, `bash`, `agent-spine`, `sessions` via `dsh-session-persistence-jsonl`, `session-checkpoints`, `subagent` + `subagent-spawn-in-process` + `tool-subagent`, `tool-todo`, `fs-local` + `fs-observation-policy` + `tool-fs`, `token-meter`, `compaction-basic`) and remove exactly the `sdk-jsonrpc-server` entry — the daemon wires `JsonRpcLineTransport`/`HarnessSdkJsonRpcServer` imperatively per connection (§6.2), not declaratively through that plugin. Keep every other entry; this feature needs the same tool/session/compaction composition a normal unattended dsh agent needs, since it *is* one, just reached over a socket instead of stdio.

### 6.5 Docs

- `packages/theus/README.md` (+ `.zh.md`), following the group-README convention (`packages/README.md`'s existing rows, e.g. the `sdk/` and `hooks/` rows quoted in §6.2, are the template: one line of role, a package table, links to child READMEs).
- New row in `packages/README.md`'s group table.
- Each new package's own README follows the canonical Model Experience format and a `## Known Limitations and Deferred Work` section (`packages/AGENTS.md`) — record the deferred items from §13 there (Windows support, word-boundary matching, no prompt-cancellation-mid-flight beyond the hook's own timeout race).

## 7. Daemon lifecycle

- **Socket path**: `dshHomePath('theus', 'daemon.sock')` from `@deepseek-ai/dsh-home-paths` (`packages/util/home-paths/src/index.ts`, verified: `dshHomePath(...segments)` joins onto the resolved `~/.dsh` or `$DSH_HOME` root) — both the daemon and the hook must resolve the same path the same way. Overridable by a `DSH_THEUS_SOCKET` env var read by both processes (a deployment-varying tunable per this repo's "no hardcoded tunables" rule, not a `DEFAULT_*`-only constant).
- **Liveness check**: a real connect attempt to the socket path, never a PID file. A crashed daemon can leave a stale socket file on disk; attempting a connection and observing `ECONNREFUSED`/`ENOENT` is the authoritative "absent" signal and needs no separate staleness bookkeeping. On a confirmed-stale socket file, unlink it before binding a new listener.
- **Starting**: `spawn(daemonBinPath, [], { detached: true, stdio: 'ignore', env: <inherited, including DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL> }).unref()`, then poll-connect the socket path within a bounded startup budget (`DSH_THEUS_DAEMON_START_TIMEOUT_MS`, document a concrete default, e.g. 10 seconds). Never sleep-loop past the budget — if the daemon doesn't come up in time, fail open (§9).
- **Idle shutdown**: a `Config` field `idleTimeoutMs` (validated, cordis.yml-overridable — genuine configurability per this repo's conventions, not a hidden default baked into `run()`) drives the timer described in §6.2 step 6.
- **Daemon crash mid-request**: the hook's socket connection errors or closes; this must be caught by the hook's own top-level try/catch and treated as a failure-open case (§9), bounded by the hook's internal timeout, never left to hang until Claude Code's own hook `timeout` kills the process.

## 8. Session mapping

One dsh session per Claude Code `session_id` (present on every `UserPromptSubmit` payload, §3) — not one session shared across the whole daemon lifetime, and not a held-open connection spanning multiple turns.

- **Why not one shared session**: the daemon's shared `agents` registry rejects registering two live agents under the same session id (`AgentRegistry.register()`, `packages/core/agent`). Two concurrent Claude Code tabs (or two overlapping `@theus` turns) must never hold the same dsh session id live at once. Deriving the dsh session id from Claude Code's own `session_id` gives natural per-tab isolation for free.
- **Why `session/resume` is required for continuity**: `session/prompt`'s lazy-create path (`HarnessSdkJsonRpcServer`'s `createSession()`, `server.ts`) always calls `ctx.agents.create()` for a session id unknown to that server instance — it never consults persisted history on its own. Each `@theus` turn is a fresh, short-lived socket connection (not a connection held open across the whole Claude Code session), so continuity across turns depends entirely on the hook explicitly calling `session/resume` before `session/prompt`, per the `session/resume`/`session/list` RPCs added by `.agents/notes/implemented/feature/2026-08-19-sdk-interactive-session-management.md`. `initialize`'s `cwd` parameter must be set to the hook payload's `cwd` (never the hook process's own `process.cwd()`), because `session/resume` only matches persisted top-level sessions whose header `cwd` matches the initialized workspace exactly.
- **Turn sequence** per invocation: connect → `initialize({cwd, ...})` → `session/resume({sessionId})` (swallow "no such session," §6.3 step 6) → `session/prompt(sessionId, strippedPrompt)` → wait idle → read `finalResponse` → close connection. Closing the connection disposes that connection's fiber and, with it, that turn's `AgentHandle` (§4.2), so the *next* `@theus` turn's `session/resume` finds no live registration to collide with. If the hook gives up early on its own internal timeout, the same disposal path applies — `AgentHandle.dispose()` stops the loop and awaits its exit rather than merely detaching bookkeeping, so an abandoned turn does not leave a runaway background LLM call.

## 9. Trigger and failure contract

- **Match**: `prompt.includes('@theus')`, case-sensitive, no boundary requirement (§6.3 step 2).
- **Strip**: remove the first occurrence of the literal `@theus` substring before sending the remaining text to dsh (§6.3 step 3).
- **Fail-open, always**: any failure at any step of §5's flow — daemon absent and fails to start in budget, connect refused, `initialize` error, `session/resume` unexpected error, `session/prompt` error, the internal run timeout elapsing, a malformed daemon response — results in printing nothing to stdout and exiting 0. Never exit 2 for an infrastructure failure; that path is reserved for a genuine policy block, which this feature never performs. This is a deliberate product decision, not an oversight, and must be recorded as such in the Agent Note (§12): enrichment features must not become availability risks for the user's actual prompt.
- **Internal request timeout**: race the full daemon round-trip (probe/spawn/connect/resume/run) against an `AbortController`-driven timeout, `DSH_THEUS_REQUEST_TIMEOUT_MS`, documented with a default meaningfully under whatever `timeout` value the shipped `hooks.json` (§10) declares — e.g. an internal default of 100 seconds against a documented recommended `hooks.json` `timeout: 120`, so the hook has room to fail open cleanly before Claude Code kills it outright.
- **Stdout discipline**: stdout carries only the one JSON line Claude Code parses on success, or nothing at all on any other path. All diagnostics go to stderr.

## 10. Packaging — standalone plugin repository

Per the confirmed distribution decision, the installable Claude Code plugin does **not** live inside `deepseek-harness`. A new standalone repository (name chosen by the implementing agent at creation time) contains:

```
<plugin-repo>/
├── .claude-plugin/
│   └── plugin.json      # name, displayName, description, version, author, license —
│                         # verify the current plugin manifest schema against Claude Code's
│                         # own current documentation at implementation time; this schema
│                         # is actively evolving and must not be assumed stable from memory.
├── hooks/
│   └── hooks.json
├── package.json          # dependencies: @deepseek-ai/dsh-theus-hook (published from this monorepo)
└── README.md              # install instructions, and the DEEPSEEK_API_KEY requirement below
```

`hooks/hooks.json` registers one `UserPromptSubmit` command hook. No `matcher` field — prompt-level events carry no tool name to match against (confirmed against `packages/hooks/hooks-claude-code/src/config.ts`'s handling of the same field for the same event class, cited here only as evidence for the wire shape, not as design authority per §2):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/node_modules/@deepseek-ai/dsh-theus-hook/lib/bin.js\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

The plugin's own README/install instructions must state plainly: this feature requires `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`) present in the environment Claude Code passes through to hook commands, since it runs real DeepSeek-backed agent turns, not deterministic tool calls — a materially different trust/cost posture than a zero-secret integration, and it must be documented as such, not left implicit.

`@deepseek-ai/dsh-theus-daemon` and `@deepseek-ai/dsh-theus-hook` are published to npm from this monorepo through its normal release process; the plugin repository consumes them as ordinary npm dependencies, keeping its own release cadence independent of this monorepo's.

## 11. Testing plan

Per `docs/testing.md` and `packages/AGENTS.md`'s "product-visible plugins require a non-unit REAL-composition test":

- **`packages/theus/daemon` unit tests**: mirror `packages/sdk/server/tests/plugin-apply.spec.ts`'s pattern (mounting the real Cordis plugin over in-memory/`PassThrough`-emulated duplex streams) but drive **two or more concurrent connections**. Assert: connection A's session never leaks into connection B's state; disposing connection A's fork does not dispose the shared `agents`/`llm`/`sessions` services (this is the direct regression test for the §4.2 fix); the idle timer fires and disposes the root only once active-connection count reaches zero and the configured timeout elapses (fake timers); a `session/resume` against a session still live on another connection surfaces the registry's actual conflict error rather than corrupting shared state.
- **`packages/theus/daemon` real-composition test**: boot the actual `examples/theus-daemon/cordis.yml` through the Loader, listen on a real temp-directory Unix socket, connect a real `net.Socket` client, and drive one full `initialize` → `session/resume` (miss) → `session/prompt` → idle → new connection → `session/resume` (hit) round trip, asserting persisted continuity survives across separate connections. Mock only the LLM boundary for the keyless variant; add a with-key e2e (self-skips without `DEEPSEEK_API_KEY`, per this repo's standing e2e policy) that sends one real `@theus`-stripped prompt end to end and asserts on externally observable effect, not a self-report (e.g., have the real turn write a file via its tools and assert the file exists).
- **`packages/theus/hook` unit tests**: mock the socket client entirely (this package is thin glue, per §6.3). Assert: `@theus` matching and stripping; correct stdin JSON parsing per §3; correct `hookSpecificOutput` JSON on success; silent exit(0) with empty stdout on every failure/timeout path in §9; the probe→spawn→wait sequence (mock `spawn` and the connect timing).
- **`packages/theus/hook` built-bin smoke test**: run the built `lib/bin.js` under plain `node` against a real (or realistically emulated) daemon socket, per this repo's `tests/built-bin.e2e.ts` convention — the published artifact is the real entry path under test, not the tsx source.
- **`packages/sdk/client` socket-mode tests**: extend the existing client test suite with a socket-launch variant mirroring the existing subprocess-launch tests — connect-failure parity with spawn-failure, close-semantics parity, `RequestTimeoutError`/transport-closed-error parity between the two launch modes.
- Every new package's `./invariant` module states a package-specific reason (§6.2, §6.3), never a generated placeholder, per `packages/AGENTS.md`.

## 12. Required Agent Note

This is a non-trivial architectural change (new packages, new daemon lifecycle pattern, a functional addition to a "stable API" package) — per root `AGENTS.md`, it requires an Agent Note in the same PR. Start at `.agents/notes/proposed/architecture/2026-08-20-theus-claude-code-hook.md`, promote to `implemented/` once shipped, following the exact skeleton in `.agents/notes/README.md`. The mandatory `## Alternatives considered` section must record, at minimum:

1. **The sibling handoff's MCP-server approach** (`.agents/handoffs/2026-08-20-claude-code-plugin-integration.md`) — Claude stays the orchestrator, DSH tools surfaced individually via `tools/list`/`tools/call`. Overridden by direct product-owner instruction for this feature; record why it does not satisfy this feature's actual requirement (routing the *whole* prompt through dsh's own system-prompt/tool/DeepSeek-model loop, not exposing deterministic tools for Claude to selectively call).
2. **Ephemeral fresh-process-per-prompt** (the pattern `packages/subagent/subagent-dsh-sdk/src/run.ts`'s `startSdkRun()` already implements: `DeepSeekHarness.start()`/`.close()` per call, no daemon at all). Simpler, zero daemon-lifecycle surface, but pays a full Cordis-tree-plus-LLM-adapter boot cost on every single `@theus` prompt and cannot share warm state across turns. Rejected as the default because this feature is meant to be an interactive, in-the-moment enrichment where per-turn latency matters; record it as the natural fallback/simpler mode if the daemon's added complexity proves not worth it in practice.
3. **Reusing `@deepseek-ai/dsh-sdk-jsonrpc-server`'s packaged `apply()` unmodified, one instance per connection** — rejected: its wire `shutdown` disposes the entire root fiber (§4.2), so any one connection's shutdown would kill every other concurrent Claude Code session's live agent. Record this verbatim so a future maintainer does not "simplify" the daemon back into this bug.
4. **One dsh session shared across the whole daemon lifetime** instead of one session per Claude Code `session_id` — rejected for the cross-talk reason in §8.

Also record as deliberate decisions, not incidental implementation details: the `packages/sdk/client` socket-launch addition (§6.1); the `session/resume`-first sequencing as the load-bearing mechanism for cross-connection continuity (§8); and the fail-open policy (§9).

## 13. Explicitly deferred — do not build now

- **Windows support**: v1 is POSIX-only (Unix domain socket). On Windows, the hook fails open unconditionally (behaves as if the daemon could never be reached) rather than attempting to start anything. Named-pipe support (`\\.\pipe\...`) is a scoped-out fast-follow, not part of this handoff's deliverable.
- **Word-boundary trigger matching**: v1 uses plain substring matching (§9). Tightening to a word-boundary regex is a fast-follow if false-positive substring matches (e.g., inside an email address) turn out to matter in practice.
- **Mid-flight prompt cancellation beyond the hook's own timeout race**: the underlying SDK protocol has no dedicated cancellation RPC (per the 2026-08-19 Agent Note's own stated consequence); this feature's only cancellation mechanism is the hook's internal timeout closing its connection early, which is sufficient for fail-open correctness (§8) but is not a general-purpose cancel-in-flight capability.

## 14. Recommended execution order

1. `packages/sdk/client` socket-launch addition (§6.1) — smallest, independently testable against the existing regression suite before anything else depends on it.
2. `packages/theus/daemon` (§6.2) — `examples/theus-daemon/cordis.yml` (§6.4) first as a static artifact, then the imperative bin (boot → socket listen → per-connection fork mount/dispose → idle timeout), verified against its real-composition test (§11) before anything downstream depends on it.
3. `packages/theus/hook` (§6.3) — built and tested against the now-real daemon.
4. Scaffold the standalone plugin repository (§10), wire it to the two published bins, smoke-test manually against a real Claude Code session.
5. Agent Note (§12), package READMEs (§6.5), `packages/README.md` row, `pnpm run doc-sync`.
