/**
 * Plugin configuration defaults and normalization.
 *
 * The plugin declares no Cordis `Config` schema, so `apply` receives the raw patch row. Every
 * deployment-varying choice therefore resolves here, once, into a complete value.
 *
 * @module dsh-bubble/src/host/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Absolute path of one configured location. */
function resolveDirectory(value, fallback) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/**
 * Normalize the patch row into the plugin's complete configuration.
 * @param raw - Raw plugin config from `cordis.patch.yml`.
 * @returns Normalized configuration.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const basePath = typeof config.basePath === 'string' && /^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/u.test(config.basePath)
    ? config.basePath
    : '/dsh-bubble'
  return {
    basePath,
    stateDir: resolveDirectory(config.stateDir, '~/.dsh/dsh-bubble'),
    workspaceName: typeof config.workspaceName === 'string' && config.workspaceName.trim() !== ''
      ? config.workspaceName.trim()
      : 'dsh_bubble',
    frontPreset: typeof config.frontPreset === 'string' && config.frontPreset.trim() !== ''
      ? config.frontPreset.trim()
      : 'standard',
    desktopExecutable: typeof config.desktopExecutable === 'string' ? config.desktopExecutable.trim() : '',
    autoStart: config.autoStart !== false,
    // The selection toolbar installs a global low-level mouse hook; it stays opt-out so a
    // deployment that dislikes the hook can disable it without touching the shell binary.
    selectionToolbar: config.selectionToolbar !== false,
    token: typeof config.token === 'string' ? config.token.trim() : '',
  }
}
