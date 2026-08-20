import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchAndStrip } from './marker.js'

test('prompt without @theus is not triggered', () => {
  const result = matchAndStrip('fix the login bug')
  assert.equal(result.triggered, false)
  assert.equal(result.stripped, 'fix the login bug')
})

test('prompt with @theus is triggered and marker is removed', () => {
  const result = matchAndStrip('@theus summarize this repo')
  assert.equal(result.triggered, true)
  assert.equal(result.stripped, ' summarize this repo')
})

test('only the first @theus occurrence is stripped', () => {
  const result = matchAndStrip('@theus tell me about @theus later')
  assert.equal(result.triggered, true)
  assert.equal(result.stripped, ' tell me about @theus later')
})

test('match is case-sensitive', () => {
  const result = matchAndStrip('@Theus should not trigger')
  assert.equal(result.triggered, false)
  assert.equal(result.stripped, '@Theus should not trigger')
})

test('substring match with no word-boundary requirement', () => {
  const result = matchAndStrip('email me at foo@theus.dev please')
  assert.equal(result.triggered, true)
  assert.equal(result.stripped, 'email me at foo.dev please')
})
