/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message) {
  let timer
  let settleTimeoutBranch
  const timeoutBranch = new Promise((resolve, reject) => {
    settleTimeoutBranch = resolve
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
  // Whichever branch loses the race is left permanently pending unless we
  // settle it ourselves here — resolving it is a harmless no-op once it has
  // already rejected via the timer firing first.
  return Promise.race([promise, timeoutBranch]).finally(() => {
    clearTimeout(timer)
    settleTimeoutBranch()
  })
}
