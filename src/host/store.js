/**
 * Durable plugin state: the ball's window geometry, the active conversation, and user preferences.
 *
 * One JSON file per concern under the configured state directory, written atomically so a crash
 * during a write never truncates the previous value.
 *
 * @module dsh-bubble/src/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Default window state before the ball has ever been moved. */
const DEFAULT_WINDOW = {
  ball: null,
  direction: { horizontal: 'right', vertical: 'down' },
  docked: null,
}

/** Default user preferences. */
const DEFAULT_PREFS = {
  selectionToolbar: true,
  theme: 'light',
  locale: 'zh',
}

async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    return fallback
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * File-backed state for one host lifetime.
 */
export class BubbleStore {
  #directory
  #windowPath
  #prefsPath
  #sessionPath
  #window = { ...DEFAULT_WINDOW }
  #prefs = { ...DEFAULT_PREFS }
  #session = { sessionId: null }

  /**
   * @param stateDir - Absolute directory that holds the plugin's JSON files.
   */
  constructor(stateDir) {
    this.#directory = stateDir
    this.#windowPath = join(stateDir, 'window.json')
    this.#prefsPath = join(stateDir, 'prefs.json')
    this.#sessionPath = join(stateDir, 'session.json')
  }

  /** Create the state directory and load both files. */
  async ready() {
    await mkdir(this.#directory, { recursive: true })
    const window = await readJson(this.#windowPath, DEFAULT_WINDOW)
    const prefs = await readJson(this.#prefsPath, DEFAULT_PREFS)
    const session = await readJson(this.#sessionPath, { sessionId: null })
    this.#window = {
      ball: window.ball ?? null,
      direction: {
        horizontal: window.direction?.horizontal === 'left' ? 'left' : 'right',
        vertical: window.direction?.vertical === 'up' ? 'up' : 'down',
      },
      docked: window.docked === 'left' || window.docked === 'right' ? window.docked : null,
    }
    this.#prefs = {
      selectionToolbar: prefs.selectionToolbar !== false,
      theme: prefs.theme === 'dark' ? 'dark' : 'light',
      locale: prefs.locale === 'en' ? 'en' : 'zh',
      model: prefs.model !== null && typeof prefs.model?.model === 'string'
        ? {
          provider: String(prefs.model.provider ?? ''),
          model: String(prefs.model.model),
          ...(typeof prefs.model.reasoningEffort === 'string' ? { reasoningEffort: prefs.model.reasoningEffort } : {}),
        }
        : null,
    }
    this.#session = { sessionId: typeof session.sessionId === 'string' ? session.sessionId : null }
  }

  /** Active ball conversation id, when one was persisted. */
  sessionId() {
    return this.#session.sessionId
  }

  /** Persist the active ball conversation. */
  async setSession(sessionId) {
    this.#session = { sessionId: typeof sessionId === 'string' ? sessionId : null }
    await writeJson(this.#sessionPath, this.#session)
  }

  /**
   * Record one request the ball made, so a broken window can be diagnosed from disk.
   * @param entry - `{ method, path, status, origin }` for the request just served.
   */
  async noteRequest(entry) {
    const log = await readJson(join(this.#directory, 'requests.json'), { entries: [] })
    const entries = Array.isArray(log.entries) ? log.entries : []
    entries.push({ at: new Date().toISOString(), ...entry })
    await writeJson(join(this.#directory, 'requests.json'), { entries: entries.slice(-40) })
  }

  /** Window geometry used to place the ball on the next desktop launch. */
  window() {
    return this.#window
  }

  /** Persist the ball's window geometry. */
  async setWindow(next) {
    this.#window = {
      ball: next.ball ?? this.#window.ball,
      direction: {
        horizontal: next.direction?.horizontal === 'left' ? 'left' : 'right',
        vertical: next.direction?.vertical === 'up' ? 'up' : 'down',
      },
      docked: next.docked === 'left' || next.docked === 'right' ? next.docked : null,
    }
    await writeJson(this.#windowPath, this.#window)
  }

  /** User preferences. */
  prefs() {
    return this.#prefs
  }

  /** Model the ball last selected, or `null` for the deployment default. */
  model() {
    return this.#prefs.model
  }

  /** Persist the ball's model choice. */
  async setModel(model) {
    this.#prefs = {
      ...this.#prefs,
      model: model === null || typeof model?.model !== 'string'
        ? null
        : {
          provider: String(model.provider ?? ''),
          model: String(model.model),
          ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
        },
    }
    await writeJson(this.#prefsPath, this.#prefs)
  }

  /** Persist one preference patch. */
  async setPrefs(patch) {
    this.#prefs = {
      ...this.#prefs,
      selectionToolbar: patch.selectionToolbar ?? this.#prefs.selectionToolbar,
      theme: patch.theme === 'dark' || patch.theme === 'light' ? patch.theme : this.#prefs.theme,
      locale: patch.locale === 'en' || patch.locale === 'zh' ? patch.locale : this.#prefs.locale,
    }
    await writeJson(this.#prefsPath, this.#prefs)
  }
}
