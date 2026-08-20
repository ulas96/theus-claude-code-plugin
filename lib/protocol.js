import { StringDecoder } from 'node:string_decoder'

/**
 * @param {unknown} obj
 * @returns {string}
 */
export function encodeFrame(obj) {
  return `${JSON.stringify(obj)}\n`
}

/** Incremental newline-delimited-JSON decoder for a byte stream. */
export class FrameDecoder {
  #decoder = new StringDecoder('utf8')
  #buffer = ''

  /**
   * @param {Buffer|string} chunk
   * @param {(obj: unknown) => void} onFrame
   */
  push(chunk, onFrame) {
    // A multi-byte UTF-8 character can straddle a chunk boundary; decoding
    // each chunk independently (the previous `chunk.toString('utf8')`
    // approach) would corrupt it. StringDecoder buffers the split bytes
    // internally until the next chunk completes them.
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
    let newlineIndex
    while ((newlineIndex = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex)
      this.#buffer = this.#buffer.slice(newlineIndex + 1)
      if (line.length === 0) continue
      try {
        onFrame(JSON.parse(line))
      } catch {
        // malformed line: skip, do not crash the connection
      }
    }
  }
}
