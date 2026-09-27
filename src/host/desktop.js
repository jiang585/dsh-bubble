/**
 * Owns the desktop shell child process that draws the floating ball.
 *
 * The shell is a Tauri executable built from `desktop/`. It receives the plugin endpoint, a
 * per-launch token, the persisted ball geometry, and the locale through the environment; it never
 * talks to the model. Restarts are bounded so a shell that cannot start does not spin.
 *
 * @module dsh-bubble/src/host/desktop
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { appendFileSync, constants } from 'node:fs'
import { join } from 'node:path'

/** Executable names tried in order when the config names none. */
const CANDIDATE_PATHS = [
  ['desktop', 'dist', 'dsh-bubble-shell.exe'],
  ['desktop', 'src-tauri', 'target', 'release', 'dsh-bubble-shell.exe'],
  ['desktop', 'src-tauri', 'target', 'debug', 'dsh-bubble-shell.exe'],
]

/** Delay before restarting a shell that exited while it was still wanted. */
const RESTART_DELAY_MS = 2000

/** A zero exit counts as the tray's deliberate quit only after the shell ran this long. */
const DELIBERATE_QUIT_MS = 10_000

/** Restarts allowed inside {@link RESTART_WINDOW_MS} before the controller gives up. */
const RESTART_LIMIT = 5

/** Window over which {@link RESTART_LIMIT} applies. */
const RESTART_WINDOW_MS = 60_000

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    return false
  }
}

/**
 * Resolve the desktop shell executable for this checkout.
 * @param packageRoot - Absolute plugin package root.
 * @param configured - Explicit executable from the plugin config.
 * @returns Absolute executable path, or undefined when the shell was never built.
 */
export async function resolveDesktopExecutable(packageRoot, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  for (const parts of CANDIDATE_PATHS) {
    const candidate = join(packageRoot, ...parts)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Spawns at most one floating-ball shell and keeps it in step with the desired state.
 */
export class DesktopProcessController {
  #packageRoot
  #configured
  #logger
  #logFile
  #child
  #startedAt
  #desired = false
  #starting
  #restarts = []
  #restartTimer
  #environment = {}
  #executable

  /**
   * @param options - Package root, configured executable, shell log path, and a warning sink.
   * @param options.packageRoot - Absolute plugin package root.
   * @param options.configured - Explicit executable path from the plugin config.
   * @param options.logFile - Absolute path the shell and this controller append lifecycle lines to.
   * @param options.logger - Sink for warnings; `warn(message, error)`.
   */
  constructor({ packageRoot, configured, logFile, logger }) {
    this.#packageRoot = packageRoot
    this.#configured = configured
    this.#logFile = logFile
    this.#logger = logger
  }

  /** Whether a shell process is currently alive. */
  running() {
    return this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed
  }

  /** Absolute executable path once resolved. */
  executable() {
    return this.#executable
  }

  /**
   * Replace the environment handed to the next shell launch.
   * @param environment - `BUBBLE_API_BASE`, `BUBBLE_TOKEN`, `BUBBLE_LOCALE`, and ball geometry.
   */
  setEnvironment(environment) {
    this.#environment = environment
  }

  /**
   * Start or stop the shell so it matches `desired`.
   * @param desired - Whether the ball should be on screen.
   */
  async setDesiredRunning(desired) {
    this.#desired = desired
    if (!desired) {
      this.stop()
      return
    }
    if (this.running() || this.#starting !== undefined) return
    this.#starting = this.#start().finally(() => {
      this.#starting = undefined
    })
    await this.#starting
  }

  /** Stop the shell and cancel any pending restart. */
  stop() {
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    const child = this.#child
    this.#child = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill()
  }

  /** Stop the shell and release every timer. */
  dispose() {
    this.#desired = false
    this.stop()
  }

  async #start() {
    if (this.#executable === undefined) {
      this.#executable = await resolveDesktopExecutable(this.#packageRoot, this.#configured)
    }
    if (this.#executable === undefined) {
      this.#logger.warn('dsh-bubble: desktop shell is not built; run `pnpm run build:desktop`')
      return
    }
    if (!this.#desired) return
    const child = spawn(this.#executable, [], {
      env: { ...process.env, ...this.#environment },
      // stdin stays open so the shell can exit when this host process dies and closes the pipe.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    this.#startedAt = Date.now()
    this.#log(`spawn pid=${child.pid ?? '?'} exe=${this.#executable}`)
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      this.#log(`stdout ${text}`)
      this.#logger.warn(`dsh-bubble shell: ${text}`)
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      this.#log(`stderr ${text}`)
      this.#logger.warn(`dsh-bubble shell: ${text}`)
    })
    child.on('error', (error) => {
      this.#log(`spawn error ${String(error)}`)
      this.#logger.warn('dsh-bubble: failed to launch the desktop shell', error)
    })
    child.on('exit', (code, signal) => {
      if (this.#child === child) this.#child = undefined
      const lived = this.#startedAt === undefined ? 0 : Date.now() - this.#startedAt
      this.#log(`exit code=${code} signal=${signal} livedMs=${lived}`)
      if (!this.#desired) return
      this.#scheduleRestart(code, signal, lived)
    })
  }

  /** Append one lifecycle line to the shell log; logging never fails the controller. */
  #log(line) {
    if (this.#logFile === undefined) return
    try {
      appendFileSync(this.#logFile, `${new Date().toISOString()} host: ${line}\n`)
    } catch {
      // A missing or locked log file must never stop the ball from starting.
    }
  }

  #scheduleRestart(code, signal, lived) {
    // A zero exit is the tray's deliberate quit, but only once the shell has actually run: an
    // immediate zero exit is a startup failure (a rejected second instance, for one) and must be
    // retried instead of silently ending the ball.
    if (code === 0 && lived >= DELIBERATE_QUIT_MS) {
      this.#desired = false
      this.#logger.warn('dsh-bubble: desktop shell closed by the user')
      return
    }
    const now = Date.now()
    this.#restarts = this.#restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    if (this.#restarts.length >= RESTART_LIMIT) {
      this.#logger.warn(`dsh-bubble: desktop shell exited ${RESTART_LIMIT} times in a minute (code ${code}, signal ${signal}); not restarting`)
      return
    }
    this.#restarts.push(now)
    this.#logger.warn(`dsh-bubble: desktop shell exited (code ${code}, signal ${signal}) after ${lived}ms; restarting`)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      void this.setDesiredRunning(true)
    }, RESTART_DELAY_MS)
  }
}
