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
- Prebuilt cross-platform binaries or a CI release pipeline. Build locally.
- Windows support.

## Architecture

One Go binary (`theus`), one process, one MCP server over stdio using the
official `github.com/modelcontextprotocol/go-sdk`. No bridge process, no
child runtime to spawn or supervise.

```
Claude Code (MCP client)
        │ stdio, MCP protocol frames only
        ▼
theus binary (single Go process)
        ├── internal/lsp   — one LSP client per language, spawned lazily
        ├── internal/term  — named PTY sessions
        └── internal/tools — MCP tool definitions, wraps the above
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

## Components

- `cmd/theus/main.go` — entrypoint; registers tools; starts the stdio
  server.
- `internal/lsp/` — LSP client management.
- `internal/term/` — terminal session management.
- `internal/tools/` — MCP tool definitions; translates between MCP
  params/results and the two managers above.

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
  clear error rather than hanging.

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
unboundedly.

## Error handling

- LSP binary missing on PATH → clear error naming the binary and an install
  command (e.g. `gopls not found; go install golang.org/x/tools/gopls@latest`).
- LSP process crash → drop the cached client, respawn lazily on the next
  call.
- File extension not in the routing table → clear error listing supported
  languages.
- Unknown terminal session name → clear error listing currently open
  sessions.
- stdout discipline (above) is non-negotiable; violating it looks like a
  server crash to the MCP client.

## Testing

- Table-driven unit tests, pure functions, no real process: extension→
  language routing, terminal output buffer/tailing logic.
- One real end-to-end smoke test per capability, no mocking: spawn the
  actual `theus` binary as a subprocess, speak MCP stdio at it.
  - LSP: against a tiny fixture Go (and/or TS) file checked into the repo,
    call `lsp_definition`, assert a real result.
  - Terminal: open a session, run `echo hello`, read it back, assert the
    output appears.
- Stdlib `testing` + `os/exec` only. No mocking framework, no test
  harness beyond what's needed for these two smoke tests.

## Open items to verify while implementing

- Confirm `github.com/modelcontextprotocol/go-sdk`'s stdio transport API
  shape at implementation time (pre-1.0 surface may have moved since this
  spec was written).
- Confirm `gopls`, `typescript-language-server`, and `pyright` are already
  on PATH in the target environment, or document the install command for
  each in the README.
