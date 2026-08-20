# Theus: a Claude Code plugin for LSP navigation and persistent terminals

Status: design approved, not yet implemented.

## Background

An earlier planning pass (`claude-code-plugin-integration.md`, superseded by
this spec) proposed exposing DeepSeek Harness (DSH) capabilities to Claude
Code by spawning a DSH child process and bridging its JSON-RPC SDK wire to
MCP. That plan required an additive change to `deepseek-harness` itself (a
new `tool/list`/`tool/execute` wire surface — see Part A of that doc) plus a
Node bridge process translating between MCP and DSH's SDK protocol.

On review, the actual goal was narrower than "integrate DSH": the target
capabilities — LSP-backed code navigation and persistent terminal sessions —
don't need DSH's runtime, agent loop, or guarded tool-execution pipeline to
exist. DSH was a means, not the end. This spec drops the DSH dependency
entirely and defines a standalone plugin, named **theus** after this repo,
that implements both capabilities directly.

**Theus is not a harness in DSH's sense — it runs no agent loop, calls no
model, makes no decisions.** Claude Code stays the only orchestrator. But
"harness" was clarified mid-design to mean something worth keeping: the
*infrastructure* DSH wraps around a tool call — containment checks, resource
limits, disciplined process lifecycle — independent of the agent loop that
decides to make the call. Theus adopts that infrastructure directly (see
Guarded Execution, below) without adopting the loop it normally serves.

The one capability this trades away is v1.1-style subagent/workflow
delegation from the original plan — that fundamentally needs a model-backed
agent runtime, which is exactly what dropping DSH removes. Out of scope for
this project; would be a separate effort if ever wanted.

## Goals

- Give Claude Code precise code navigation (go-to-definition, find
  references, go-to-implementation, hover) backed by real language servers,
  not text search.
- Give Claude Code persistent, named terminal sessions it can write commands
  to and tail output from independently (e.g. run a dev server in one
  session, tail logs in another) — something a one-shot `Bash` tool call
  can't do.
- Guard every LSP and terminal call the way DSH guards a tool call —
  workspace containment, resource limits, clean process lifecycle — without
  running an agent loop to decide when to make the call.
- Zero install friction beyond having the relevant language server on PATH:
  no DSH, no Node bridge, no API keys, no secrets.
- Scoped to personal daily-driver use on Mac and Linux. No Windows support,
  no distribution pipeline, no multi-tenant config system.

## Non-goals

- Subagent/workflow delegation (needs a model-backed agent runtime — out of
  scope now that DSH is dropped).
- General filesystem or shell tools — redundant with Claude Code's native
  Read/Edit/Write/Bash.
- A user-configurable language→command mapping. Three hardcoded language
  servers cover the realistic case; add a fourth only when actually needed.
- A generic, pluggable pre-/post-execute hook *waterfall* like
  `ToolRuntime.execute()`'s. That architecture earns its keep in DSH because
  DSH is a multi-tool framework with third-party guard plugins as
  consumers. Theus has nine fixed tools and one consumer (Claude Code) — an
  extensibility layer nothing will ever plug into is speculative. The same
  protections are applied directly, as plain function calls, not through a
  hook system.
- OS-level sandboxing (containers, seccomp, chroot). Workspace containment
  plus resource limits is the right altitude for a personal Mac/Linux tool;
  revisit only if theus is ever exposed beyond that.
- Prebuilt cross-platform binaries or a CI release pipeline. Build locally.
- Windows support.

## Architecture

One Go binary (`theus`), one process, one MCP server over stdio using the
official `github.com/modelcontextprotocol/go-sdk`. No bridge process, no
child runtime to spawn or supervise, no agent loop.

```
Claude Code (MCP client)
        │ stdio, MCP protocol frames only
        ▼
theus binary (single Go process)
        │
        ▼
internal/tools   — MCP tool definitions
        │  every call passes through internal/guard first
        ▼
internal/guard   — containment check, resource limits, error mapping
        │
        ├── internal/lsp   — one LSP client per language, spawned lazily
        └── internal/term  — named PTY sessions
```

`.claude-plugin/plugin.json` names the plugin `theus`. `.mcp.json` at the
plugin root declares the server:

```json
{
  "mcpServers": {
    "theus": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/theus"
    }
  }
}
```

**Distribution**: build locally (`make build` → `bin/theus`), not prebuilt
per-platform binaries or a release pipeline. This is a personal-use plugin
on known Mac/Linux machines, not something distributed to strangers — a
release pipeline would be process for a problem that doesn't exist here.
Rebuild after pulling changes.

**Hard constraint carried over from the original plan and still true**:
stdout carries MCP protocol frames only. Any stray log line breaks the
client's frame parser. All diagnostics go to stderr.

## Guarded execution

Three protections, adopted directly from how DSH treats a tool call, applied
as plain functions every LSP/terminal tool calls into — not through a
generic hook framework (see Non-goals).

**1. Workspace containment.** Every call that names a filesystem path (an
LSP `file`, a terminal `cwd`) is canonicalized and checked against the
process's fixed workspace root before it touches an LSP server or spawns a
shell. A path that resolves outside the root is rejected before any
external process runs — the same discipline `dsh-lsp-stdio` applies
("rejects... canonically out-of-workspace query sources before server
startup").

**2. Resource limits.** Concrete caps, not unbounded behavior:
- LSP: a max document size accepted for a query, a max message size
  accepted from a server, and a per-call timeout.
- Terminal: a cap on concurrent open sessions, and the already-planned
  bounded per-session output buffer (evict oldest, don't grow unbounded).

**3. Disciplined process lifecycle.** Theus catches `SIGTERM`/`SIGINT`,
runs LSP `shutdown`/`exit` on every cached client and kills every open
terminal session, with a grace period before escalating to a hard kill —
rather than exiting and leaving `gopls`/shell processes orphaned, which is a
known failure mode DSH itself documents ("a hard-killed harness orphans
language servers").

Violations of any of these surface as one of a small set of structured
error codes (see Error handling) rather than ad hoc strings — cheap
consistency, same spirit as DSH's `LSP_MALFORMED_RESPONSE`/`UNKNOWN_TOOL`
naming.

## Components

- `cmd/theus/main.go` — entrypoint; registers tools; starts the stdio
  server; owns the `SIGTERM`/`SIGINT` shutdown sequence.
- `internal/guard/` — containment check, resource-limit constants, and the
  shared error-code type every tool maps failures onto.
- `internal/lsp/` — LSP client management.
- `internal/term/` — terminal session management.
- `internal/tools/` — MCP tool definitions; calls `internal/guard` first,
  then translates between MCP params/results and the two managers above.

### LSP design (informed directly by DSH's own `dsh-lsp-stdio` /
`dsh-tool-lsp` precedent, read from the deepseek-harness source)

DSH's LSP host is static configuration, not runtime detection: each
language server is declared once (`command`, `args`, `extensionToLanguage`
map, resource limits, timeouts), and the workspace root is one fixed value
for the whole session (`session.header.cwd`, no fallback, no per-call
directory search). Theus adopts the same shape, simplified further since
there's no multi-tenant session concept:

- **Workspace root**: one fixed value for the process's whole lifetime —
  the working directory `theus` starts in (mirrors `CLAUDE_PROJECT_DIR`).
  No per-file directory walk-up, no multi-root juggling.
- **Language routing**: file extension against a hardcoded table, not
  project-marker detection:
  - `.go` → `gopls`
  - `.ts`, `.tsx`, `.js`, `.jsx` → `typescript-language-server`
  - `.py` → `pyright`
- **Client**: hand-rolled JSON-RPC-over-`Content-Length`-framed-stdio.
  No existing Go library matches TS's `vscode-languageserver-protocol`
  maturity, but the needed surface is small: `initialize`,
  `textDocument/didOpen`, `textDocument/definition`,
  `textDocument/references`, `textDocument/implementation`,
  `textDocument/hover`, `textDocument/didClose`. DSH's transient-open
  pattern (open → query → close per call, no diffing/didChange) is worth
  reusing directly — it avoids needing a document cache or LRU.
- **Lifecycle**: one server process per language, spawned lazily on first
  use, cached for the process's lifetime. On crash, drop the cached client
  and respawn lazily on the next call; the failed call itself surfaces a
  clear error rather than hanging. On theus shutdown, every cached client
  gets a graceful `shutdown`/`exit` (see Guarded execution).

### Tool surface

LSP (mirrors DSH's four operations):

- `lsp_definition(file, line, character)`
- `lsp_references(file, line, character)` — includes the declaration site
- `lsp_implementation(file, line, character)`
- `lsp_hover(file, line, character)`

Coordinates are one-based, UTF-16 — same convention as DSH's tool, so the
model-facing contract has precedent.

Terminal:

- `terminal_open(name, cwd?, shell?)` — start a named persistent session
- `terminal_run(name, command)` — write a command line to an open session
- `terminal_read(name, since?)` — read captured output since the last read,
  for tailing
- `terminal_list()` — list active sessions
- `terminal_kill(name)` — terminate a session

Terminal sessions are named PTYs via `github.com/creack/pty`, held in
`map[string]*Session`. Each session's captured output is a bounded buffer
(capped by size) so long-running tailed processes don't grow memory
unboundedly; opening past the concurrent-session cap is rejected (Guarded
execution, above).

## Error handling

A small, named set of error codes, mapped onto MCP tool errors, rather than
ad hoc message strings — mirrors DSH's `LSP_MALFORMED_RESPONSE`/
`UNKNOWN_TOOL`/`LSP_WORKSPACE_REQUIRED` naming:

| Code | When |
|---|---|
| `ERR_OUT_OF_WORKSPACE` | A file path or terminal `cwd` resolves outside the workspace root. |
| `ERR_LSP_SERVER_NOT_FOUND` | The language server binary isn't on PATH; message names the binary and an install command. |
| `ERR_LSP_UNSUPPORTED_EXTENSION` | The file extension isn't in the routing table; message lists supported languages. |
| `ERR_LSP_TIMEOUT` | A call exceeded its resource-limit timeout. |
| `ERR_TERMINAL_SESSION_NOT_FOUND` | An unknown session name; message lists currently open sessions. |
| `ERR_TERMINAL_LIMIT_REACHED` | `terminal_open` would exceed the concurrent-session cap. |

An LSP process crash drops the cached client and respawns lazily on the
next call rather than failing every subsequent call. stdout discipline
(above) is non-negotiable; violating it looks like a server crash to the
MCP client, not a normal tool error.

## Testing

- Table-driven unit tests, pure functions, no real process: extension→
  language routing, terminal output buffer/tailing logic, the containment
  check (`internal/guard`) against a table of inside/outside/edge-case
  paths (symlinks, `..`, trailing slashes).
- One real end-to-end smoke test per capability, no mocking: spawn the
  actual `theus` binary as a subprocess, speak MCP stdio at it.
  - LSP: against a tiny fixture Go (and/or TS) file checked into the repo,
    call `lsp_definition`, assert a real result.
  - Terminal: open a session, run `echo hello`, read it back, assert the
    output appears.
- One real shutdown smoke test: spawn `theus`, open a terminal session and
  trigger an LSP client spawn, send `SIGTERM`, and confirm (via PID
  liveness) that the child processes are gone rather than orphaned — the
  one runnable check for the lifecycle guarantee in Guarded execution §3.
- Stdlib `testing` + `os/exec` only. No mocking framework, no test
  harness beyond what's needed for these smoke tests.

## Open items to verify while implementing

- Confirm `github.com/modelcontextprotocol/go-sdk`'s stdio transport API
  shape at implementation time (pre-1.0 surface may have moved since this
  spec was written).
- Confirm `gopls`, `typescript-language-server`, and `pyright` are already
  on PATH in the target environment, or document the install command for
  each in the README.
- Confirm process-group signal semantics for tree-killing a language
  server's descendants on Mac vs. Linux (both POSIX, but worth a real
  check rather than assuming parity).
