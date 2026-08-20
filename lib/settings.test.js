import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModelSelection, DEFAULT_MODEL_SELECTION } from './settings.js'

test('absent document falls back to the default selection', () => {
  const selection = parseModelSelection(undefined)
  assert.deepEqual(selection, DEFAULT_MODEL_SELECTION)
})

test('document without an agent-default-model section falls back to default', () => {
  const selection = parseModelSelection('other-namespace:\n  foo: bar\n')
  assert.deepEqual(selection, DEFAULT_MODEL_SELECTION)
})

test('reads provider and model from the agent-default-model section', () => {
  const selection = parseModelSelection('agent-default-model:\n  provider: anthropic\n  model: claude-sonnet-4-5\n')
  assert.deepEqual(selection, { provider: 'anthropic', model: 'claude-sonnet-4-5' })
})

test('a malformed document falls back to default rather than throwing', () => {
  const selection = parseModelSelection('not: [valid: yaml')
  assert.deepEqual(selection, DEFAULT_MODEL_SELECTION)
})
