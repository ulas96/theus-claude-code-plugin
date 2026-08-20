import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, FrameDecoder } from './protocol.js'

test('encodeFrame produces one JSON line terminated by \\n', () => {
  const frame = encodeFrame({ sessionId: 'abc', prompt: 'hi' })
  assert.equal(frame, '{"sessionId":"abc","prompt":"hi"}\n')
})

test('FrameDecoder yields one object per complete line', () => {
  const decoder = new FrameDecoder()
  const seen = []
  decoder.push(Buffer.from('{"a":1}\n{"a":2}\n'), (obj) => seen.push(obj))
  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }])
})

test('FrameDecoder buffers a line split across chunks', () => {
  const decoder = new FrameDecoder()
  const seen = []
  decoder.push(Buffer.from('{"a":'), (obj) => seen.push(obj))
  assert.deepEqual(seen, [])
  decoder.push(Buffer.from('1}\n'), (obj) => seen.push(obj))
  assert.deepEqual(seen, [{ a: 1 }])
})

test('FrameDecoder skips a malformed line without throwing', () => {
  const decoder = new FrameDecoder()
  const seen = []
  decoder.push(Buffer.from('not json\n{"a":1}\n'), (obj) => seen.push(obj))
  assert.deepEqual(seen, [{ a: 1 }])
})

test('FrameDecoder correctly decodes a multi-byte UTF-8 character split across chunks', () => {
  const decoder = new FrameDecoder()
  const seen = []
  const full = Buffer.from('{"emoji":"😀"}\n', 'utf8')
  // Split in the middle of the emoji's 4-byte UTF-8 sequence.
  const splitIndex = full.indexOf(Buffer.from('😀', 'utf8')) + 2
  decoder.push(full.subarray(0, splitIndex), (obj) => seen.push(obj))
  decoder.push(full.subarray(splitIndex), (obj) => seen.push(obj))
  assert.deepEqual(seen, [{ emoji: '😀' }])
})
