import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envInt } from './env.js'

test('returns the fallback when the variable is absent', () => {
  assert.equal(envInt({}, 'FOO', 42), 42)
})

test('returns the fallback when the variable is an empty string', () => {
  assert.equal(envInt({ FOO: '' }, 'FOO', 42), 42)
})

test('parses a present, non-empty value', () => {
  assert.equal(envInt({ FOO: '100' }, 'FOO', 42), 100)
})
