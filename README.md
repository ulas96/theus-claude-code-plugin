# theus-claude-code-plugin

A Claude Code plugin. Type `@theus` anywhere in a prompt and, before Claude answers, the
prompt (marker stripped) is routed through a self-hosted [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) agent turn — its own tools, session history, and agent loop — and the result is
injected back as grounding context (`additionalContext`) for that turn. Claude stays the
model that actually answers; dsh is a pre-processing enrichment step.

## Requirements

- Node.js.
- **An already-configured local [dsh](https://github.com/deepseek-ai/deepseek-harness) installation** with a working
  default model — i.e. `~/.dsh/settings.yaml` already has a provider/model selection (or
  you're fine with dsh's own out-of-the-box default). This plugin does **not** introduce a
  new model dependency or require a fresh API key: it reuses whichever LLM provider your own
  dsh setup is already configured with (DeepSeek, Anthropic, OpenAI, or anything else dsh's
  `llm-pi-ai` adapter supports), read straight from your existing `~/.dsh/settings.yaml` and
  `~/.dsh/.credentials.yaml` / environment. No secrets are introduced by this plugin itself.

## How it works

1. `hooks/hooks.json` registers `bin/theus-hook.js` on Claude Code's `UserPromptSubmit` event.
2. A prompt without `@theus` is a complete no-op — the hook exits immediately, nothing is sent
   anywhere.
3. A prompt containing `@theus`: the marker is stripped, and the hook talks to
   `bin/theus-daemon.js` over a small Unix-socket protocol of its own (starting the daemon on
   first use if it isn't already running).
4. The daemon owns exactly one `dsh-jsonrpc-agent` subprocess (booted from
   `cordis/theus.cordis.yml`, this plugin's own dsh composition) for its whole lifetime, and
   multiplexes every Claude Code session's `@theus` turns onto it by dsh session id — one dsh
   session per Claude Code session, so a follow-up `@theus` prompt in the same conversation
   continues the prior turn's dsh session, **for as long as the daemon's subprocess has stayed
   up continuously**. There is no cross-restart resume: the installed dsh SDK server has no
   `session/resume` RPC, so a subprocess restart (idle shutdown or crash) always starts that
   session fresh, with no prior history, even though it keeps the same session id.
5. The daemon shuts itself down after a period of inactivity (`THEUS_DAEMON_IDLE_TIMEOUT_MS`,
   default 10 minutes) and is restarted on the next `@theus` trigger — losing continuity for
   every session that was in progress, per the point above.
6. **This feature fails open, always.** Any failure anywhere in the flow — the daemon fails to
   start, a request times out, dsh itself errors — results in the hook printing nothing and
   exiting successfully. A broken or absent dsh installation never blocks a normal Claude Code
   prompt; it just means `@theus` prompts get no extra context.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `THEUS_SOCKET` | `~/.theus-plugin/daemon.sock` | Path to the daemon's own Unix socket. |
| `THEUS_DAEMON_START_TIMEOUT_MS` | `10000` | How long the hook waits for a freshly spawned daemon to come up. |
| `THEUS_REQUEST_TIMEOUT_MS` | `100000` | How long the hook waits for one `@theus` turn to finish, kept comfortably under `hooks.json`'s `timeout: 120`. The daemon reads the same variable to bound its own wait on that turn, so a stuck turn can't wedge every other session's requests behind it in the daemon's serialized queue. |
| `THEUS_DAEMON_IDLE_TIMEOUT_MS` | `600000` | How long the daemon stays alive with zero active requests before shutting itself down. |
| `DSH_HOME` | `~/.dsh` | Where the daemon reads your existing dsh settings/credentials from — the same location a normal `dsh` session already uses. |

## Scope / known limitations

- POSIX only (Unix domain socket) — no Windows support in v1.
- Trigger matching is a plain, case-sensitive substring check (`prompt.includes('@theus')`),
  not word-boundary-aware.
- Concurrent `@theus` turns across different Claude Code sessions are serialized by the daemon
  rather than run in parallel.
- No cross-restart session continuity: a dsh session survives only as long as the daemon's one
  subprocess stays up continuously. Restarting it (idle timeout or crash) always starts every
  session fresh, since the installed dsh SDK server has no `session/resume` RPC to recover
  persisted history from.
- A daemon-side timeout stops *waiting* on a stuck `@theus` turn so it can't wedge other
  sessions' requests, but it cannot cancel the turn itself — the dsh SDK has no cancellation
  RPC, so an abandoned turn keeps running in the subprocess until it finishes on its own.
- The daemon's one dsh subprocess is shared for its whole idle lifetime, so its fs/bash-tool
  workspace (`DSH_CWD`) is pinned once, from whichever project's `@theus` prompt first starts
  it — not re-scoped per request. A different project's `@theus` turn within that same daemon
  lifetime still runs, grounded against the *first* project's files, until the idle timeout
  restarts the daemon against a fresh cwd.
- **No filesystem/command containment.** `cordis/theus.cordis.yml` grants the dsh agent real
  bash and filesystem tool access (`dsh-bash-local`, `dsh-fs-local`), scoped only by a `cwd`
  default and a 60s bash timeout — neither backend enforces that `cwd` as a boundary (both say
  so in their own docs), and no sandboxing/permission layer sits in front of them here. This is
  a direct consequence of this plugin's design: `@theus` deliberately routes the whole prompt
  through dsh's own agent loop with its own tools, not a restricted, individually-approved tool
  subset. Real containment exists upstream (`@deepseek-ai/dsh-sandbox-local` +
  `@deepseek-ai/dsh-bash-sandbox`) but isn't wired in here, and there's no equivalent sandboxed
  backend for the filesystem tools at all yet — see this repo's current findings before relying
  on this in an untrusted-prompt setting.

## Development

```sh
npm install
npm test   # pure-logic unit tests (marker matching, protocol framing, settings parsing)
```
