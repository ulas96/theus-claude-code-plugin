import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from './timeout.js'

test('resolves with the promise value when it settles before the timeout', async () => {
  const result = await withTimeout(Promise.resolve('done'), 1000, 'timed out')
  assert.equal(result, 'done')
})

test('rejects with the timeout message when the promise settles too late', async () => {
  const slow = new Promise((resolve) => { setTimeout(() => resolve('too late'), 50) })
  await assert.rejects(withTimeout(slow, 10, 'timed out'), /timed out/)
  await slow
})

test('propagates the original rejection when the promise rejects before the timeout', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, 'timed out'), /boom/)
})
