import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSocketPath } from './socket-path.js'

test('defaults to ~/.theus-plugin/daemon.sock', () => {
  const path = resolveSocketPath({}, '/home/alice')
  assert.equal(path, '/home/alice/.theus-plugin/daemon.sock')
})

test('THEUS_SOCKET env var overrides the default', () => {
  const path = resolveSocketPath({ THEUS_SOCKET: '/tmp/custom.sock' }, '/home/alice')
  assert.equal(path, '/tmp/custom.sock')
})

test('empty THEUS_SOCKET is treated as absent', () => {
  const path = resolveSocketPath({ THEUS_SOCKET: '' }, '/home/alice')
  assert.equal(path, '/home/alice/.theus-plugin/daemon.sock')
})
