import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * dsh's own composition-level default (`packages/bundle/base/cordis.patch.yml`,
 * `agent-default-model` row) — what a fresh dsh install resolves to before any
 * user selection is saved. Used here only as the same fallback dsh itself uses,
 * never as a value this plugin prefers.
 * @type {{ provider: string, model: string }}
 */
export const DEFAULT_MODEL_SELECTION = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/**
 * Parse the `agent-default-model` settings namespace out of dsh's settings
 * document text (see `@deepseek-ai/dsh-agent-default-model`'s
 * `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE` / `packages/settings/settings-file`).
 * @param {string|undefined} text - the document's raw text, or undefined if the file is absent.
 * @returns {{ provider: string, model: string }}
 */
export function parseModelSelection(text) {
  if (text === undefined) return DEFAULT_MODEL_SELECTION
  let doc
  try {
    doc = parse(text)
  } catch {
    return DEFAULT_MODEL_SELECTION
  }
  const section = doc?.['agent-default-model']
  if (typeof section?.provider !== 'string' || typeof section.model !== 'string') return DEFAULT_MODEL_SELECTION
  return { provider: section.provider, model: section.model }
}

/**
 * Resolve the user's already-configured dsh model selection from
 * `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`), the same
 * document a normal dsh session reads.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ provider: string, model: string }>}
 */
export async function loadModelSelection(env = process.env) {
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  let text
  try {
    text = await readFile(join(dshHome, 'settings.yaml'), 'utf8')
  } catch {
    text = undefined
  }
  return parseModelSelection(text)
}
