/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envInt(env, name, fallback) {
  const value = env[name]
  return value === undefined || value === '' ? fallback : Number(value)
}
