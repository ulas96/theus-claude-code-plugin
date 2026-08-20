const MARKER = '@theus'

/**
 * @param {string} prompt
 * @returns {{ triggered: boolean, stripped: string }}
 */
export function matchAndStrip(prompt) {
  const index = prompt.indexOf(MARKER)
  if (index === -1) return { triggered: false, stripped: prompt }
  return {
    triggered: true,
    stripped: prompt.slice(0, index) + prompt.slice(index + MARKER.length),
  }
}
