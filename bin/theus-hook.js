#!/usr/bin/env node
/**
 * UserPromptSubmit hook: triggers on the literal substring "@theus", strips
 * it, and enriches the prompt via the theus daemon's dsh agent turn. Always
 * fails open — any failure anywhere prints nothing and exits 0. See
 * /Users/ulas/.claude/plans/stateless-twirling-wozniak.md.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { envInt } from '../lib/env.js'
import { matchAndStrip } from '../lib/marker.js'
import { encodeFrame, FrameDecoder } from '../lib/protocol.js'
import { resolveSocketPath } from '../lib/socket-path.js'

const DAEMON_START_TIMEOUT_MS = envInt(process.env, 'THEUS_DAEMON_START_TIMEOUT_MS', 10_000)
const REQUEST_TIMEOUT_MS = envInt(process.env, 'THEUS_REQUEST_TIMEOUT_MS', 100_000)
const DAEMON_POLL_INTERVAL_MS = 200

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => { resolvePromise(data) })
    process.stdin.on('error', rejectPromise)
  })
}

/**
 * @param {string} socketPath
 * @returns {Promise<import('node:net').Socket>}
 */
function tryConnect(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => { resolvePromise(socket) })
    socket.once('error', rejectPromise)
  })
}

/**
 * @param {string} socketPath
 * @param {number} deadline - epoch ms
 * @returns {Promise<import('node:net').Socket>}
 */
async function connectOrSpawnDaemon(socketPath, deadline) {
  try {
    return await tryConnect(socketPath)
  } catch {
    // fall through to spawn
  }

  const daemonPath = fileURLToPath(new URL('./theus-daemon.js', import.meta.url))
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // Without this, an async spawn failure (ENOENT/EACCES/EMFILE) throws
  // uncaught on a separate tick from this function's try/catch, crashing the
  // hook instead of the fail-open behavior documented at the top of this file.
  child.on('error', () => {})

  while (Date.now() < deadline) {
    try {
      return await tryConnect(socketPath)
    } catch {
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS))
    }
  }
  throw new Error('timed out waiting for theus daemon to start')
}

/**
 * @param {import('node:net').Socket} socket
 * @param {{ sessionId: string, cwd: string, prompt: string }} request
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, finalResponse?: string, error?: string }>}
 */
function requestDaemon(socket, request, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const decoder = new FrameDecoder()
    const timer = setTimeout(() => {
      settled = true
      socket.destroy()
      rejectPromise(new Error('daemon request timed out'))
    }, timeoutMs)
    timer.unref()
    socket.on('data', (chunk) => {
      decoder.push(chunk, (response) => {
        settled = true
        clearTimeout(timer)
        socket.end()
        resolvePromise(/** @type {{ok: boolean, finalResponse?: string, error?: string}} */ (response))
      })
    })
    socket.on('error', (error) => {
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    // A daemon crash mid-request closes the socket cleanly (no 'error'
    // event) — without this, that case would otherwise stall until the full
    // timeout elapses instead of failing open immediately.
    socket.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new Error('daemon closed the connection before responding'))
    })
    socket.write(encodeFrame(request))
  })
}

async function main() {
  const raw = await readStdin()
  const payload = JSON.parse(raw)
  const { triggered, stripped } = matchAndStrip(String(payload.prompt ?? ''))
  if (!triggered) return
  // A missing/non-string session_id has no safe default: falling back to ''
  // would multiplex every such invocation onto the same dsh session. Claude
  // Code's UserPromptSubmit contract always includes it, so treat its
  // absence as a malformed payload and fail open rather than guess.
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  const socketPath = resolveSocketPath(process.env, homedir())
  const socket = await connectOrSpawnDaemon(socketPath, deadline)
  const response = await requestDaemon(
    socket,
    { sessionId: payload.session_id, cwd: String(payload.cwd ?? process.cwd()), prompt: stripped },
    REQUEST_TIMEOUT_MS,
  )
  if (!response.ok || typeof response.finalResponse !== 'string') {
    throw new Error(response.error ?? 'daemon returned no result')
  }
  // An empty finalResponse means the dsh turn produced no assistant text (e.g.
  // an upstream LLM error surfaced as a turn/end event rather than a thrown
  // error) — nothing useful to inject, so this is a no-op, not a failure.
  if (response.finalResponse === '') return

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: response.finalResponse,
    },
  }))
}

main().catch((error) => {
  process.stderr.write(`theus-hook: ${error?.stack ?? String(error)}\n`)
})
