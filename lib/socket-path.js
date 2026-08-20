import { join } from 'node:path'

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homedir
 * @returns {string}
 */
export function resolveSocketPath(env, homedir) {
  const override = env.THEUS_SOCKET
  if (override !== undefined && override !== '') return override
  return join(homedir, '.theus-plugin', 'daemon.sock')
}
