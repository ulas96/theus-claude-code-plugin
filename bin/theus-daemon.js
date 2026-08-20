#!/usr/bin/env node
/**
 * Long-lived daemon: owns exactly one dsh-jsonrpc-agent subprocess (spawned via
 * @deepseek-ai/dsh-sdk-client's existing, unmodified subprocess-launch mode) and
 * multiplexes theus-hook.js requests onto it over its own small Unix-socket
 * protocol. See /Users/ulas/.claude/plans/stateless-twirling-wozniak.md.
 */
import { mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, TransportClosedError } from '@deepseek-ai/dsh-sdk-client'
import { envInt } from '../lib/env.js'
import { encodeFrame, FrameDecoder } from '../lib/protocol.js'
import { loadModelSelection } from '../lib/settings.js'
import { resolveSocketPath } from '../lib/socket-path.js'
import { withTimeout } from '../lib/timeout.js'

const IDLE_TIMEOUT_MS = envInt(process.env, 'THEUS_DAEMON_IDLE_TIMEOUT_MS', 10 * 60 * 1000)
// Bounds one dsh turn, not the whole daemon: without this, a stuck turn (LLM
// hang, wedged tool call) would hold the single request `queue` below forever,
// since the installed dsh SDK has no run-cancellation RPC to fall back on.
// Kept in step with the hook's own THEUS_REQUEST_TIMEOUT_MS (theus-hook.js)
// so the daemon gives up around the same time the hook's own socket wait does.
const REQUEST_TIMEOUT_MS = envInt(process.env, 'THEUS_REQUEST_TIMEOUT_MS', 100_000)

/**
 * A real connect attempt is the only authoritative liveness signal for a Unix
 * socket — a stale file left behind by a crashed daemon looks identical to a
 * live one on disk. Used to avoid unlinking (and thereby stealing) a socket
 * another daemon is still actively listening on.
 * @param {string} socketPath
 * @returns {Promise<boolean>}
 */
function probeDaemon(socketPath) {
  return new Promise((resolveProbe) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.end()
      resolveProbe(true)
    })
    socket.once('error', () => { resolveProbe(false) })
  })
}

async function main() {
  const socketPath = resolveSocketPath(process.env, homedir())
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (await probeDaemon(socketPath)) {
    // Another daemon is already live on this socket; do not steal it. A
    // narrow race remains if two daemons probe at the exact same instant
    // (neither observes the other yet) — unavoidable without a separate
    // lock file, which the socket-connect probe is meant to substitute for.
    return
  }
  await unlink(socketPath).catch(() => {})

  const binPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin'))
  const cordisPath = fileURLToPath(new URL('../cordis/theus.cordis.yml', import.meta.url))
  const { provider, model } = await loadModelSelection()

  // Session persistence is this daemon's own state, unrelated to whichever
  // project cwd happens to trigger a turn — pin it under our own namespace so
  // it never lands inside an arbitrary Claude Code project directory.
  const sessionRoot = new URL('sessions/', `file://${homedir()}/.theus-plugin/`)
  process.env.DSH_SESSION_ROOT ??= fileURLToPath(sessionRoot)

  /** @type {import('@deepseek-ai/dsh-sdk-client').DeepSeekHarness | undefined} */
  let harness

  // The subprocess is one shared instance for this daemon's whole idle
  // lifetime, so its fs/bash-tool workspace (DSH_CWD) and session-header cwd
  // are pinned once, from whichever request first starts it — not
  // re-scoped per request. A different project's @theus turn within the same
  // daemon lifetime still runs, grounded against the first project's
  // workspace; the idle timeout (THEUS_DAEMON_IDLE_TIMEOUT_MS) bounds how
  // long that staleness can persist. See README's "Scope / known limitations".
  /** @param {string} cwd */
  function ensureHarness(cwd) {
    if (harness !== undefined) return harness
    process.env.DSH_CWD ??= cwd
    harness = new DeepSeekHarness({
      launch: { command: process.execPath, args: [binPath, cordisPath] },
      cwd,
      provider,
      model,
    })
    return harness
  }

  /**
   * @param {{ sessionId?: unknown, cwd?: unknown, prompt?: unknown }} request
   */
  async function handleRequest(request) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
    const cwd = typeof request.cwd === 'string' ? request.cwd : undefined
    const prompt = typeof request.prompt === 'string' ? request.prompt : undefined
    if (sessionId === undefined || cwd === undefined || prompt === undefined) {
      return { ok: false, error: 'malformed request: sessionId, cwd, and prompt are required strings' }
    }
    const harnessInstance = ensureHarness(cwd)
    // start() is memoized by the SDK client itself (no-op after the first
    // successful call), so no bookkeeping of our own is needed here.
    await harnessInstance.start()
    // No explicit resume step: the underlying dsh-sdk-jsonrpc-server (see
    // README) doesn't implement a `session/resume` RPC at all — it always
    // throws "unknown DeepSeek Harness SDK runtime method". session/prompt's
    // own session cache already gives continuity for free, keyed by this same
    // sessionId, for as long as this daemon's one subprocess stays alive; that
    // continuity is lost only across a subprocess restart (crash or idle
    // shutdown), which nothing in the current dependency surface can recover.
    try {
      const result = await withTimeout(
        harnessInstance.session(sessionId).run(prompt),
        REQUEST_TIMEOUT_MS,
        'dsh turn timed out',
      )
      return { ok: true, finalResponse: result.finalResponse }
    } catch (error) {
      // DeepSeekHarness.start() only re-launches after a *failed* handshake
      // (it resets `initialized` in that one case); a subprocess that dies
      // later leaves `initialized` resolved forever, so `harness` above would
      // otherwise keep being handed back, dead, to every future request until
      // the unrelated idle timer eventually restarts the whole daemon.
      // TransportClosedError is the SDK's own signal that the subprocess is
      // gone — discard the harness so the next request builds a fresh one.
      if (error instanceof TransportClosedError) {
        harness = undefined
        void harnessInstance.close().catch(() => {})
      }
      throw error
    }
  }

  let activeConnections = 0
  let idleTimer

  function cancelIdleShutdown() {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  function scheduleIdleShutdown() {
    cancelIdleShutdown()
    idleTimer = setTimeout(() => { void shutdown(0) }, IDLE_TIMEOUT_MS)
    idleTimer.unref()
  }

  let shuttingDown = false
  /** @param {number} code */
  async function shutdown(code) {
    if (shuttingDown) return
    shuttingDown = true
    cancelIdleShutdown()
    server.close()
    await unlink(socketPath).catch(() => {})
    await harness?.close().catch(() => {})
    process.exit(code)
  }

  // One request at a time: true concurrency safety of interleaved
  // session/prompt calls across session ids on one connection is unverified
  // (see plan's "out of scope for v1"); serializing is the safe default.
  let queue = Promise.resolve()

  const server = createServer((socket) => {
    activeConnections++
    cancelIdleShutdown()
    const decoder = new FrameDecoder()
    socket.on('data', (chunk) => {
      decoder.push(chunk, (request) => {
        queue = queue
          .then(() => handleRequest(/** @type {{sessionId?: unknown, prompt?: unknown}} */ (request)))
          .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
          .then((response) => { socket.write(encodeFrame(response)) })
      })
    })
    socket.on('close', () => {
      activeConnections--
      if (activeConnections === 0) scheduleIdleShutdown()
    })
    socket.on('error', () => {})
  })

  // Registered before the startup race below so there is always at least one
  // 'error' listener on `server` — otherwise, once the one-shot startup
  // listener self-removes after firing, a second later server-level error
  // would have no listener at all and crash the process via Node's default
  // uncaught-'error' behavior.
  server.on('error', (error) => {
    process.stderr.write(`theus-daemon: server error: ${error?.stack ?? String(error)}\n`)
  })

  await new Promise((resolvePromise, rejectPromise) => {
    const onStartupError = rejectPromise
    server.once('error', onStartupError)
    server.listen(socketPath, () => {
      server.removeListener('error', onStartupError)
      resolvePromise(undefined)
    })
  })
  scheduleIdleShutdown()

  process.on('SIGTERM', () => { void shutdown(0) })
  process.on('SIGINT', () => { void shutdown(0) })
}

main().catch((error) => {
  process.stderr.write(`theus-daemon: fatal: ${error?.stack ?? String(error)}\n`)
  process.exit(1)
})
