/**
 * DSH Bubble — the desktop floating ball, installed as a DeepSeek Harness plugin.
 *
 * The plugin owns three things: the ball's conversation on the harness side, an HTTP + SSE surface
 * the ball window talks to, and a child process running the Tauri window shell. It imports no
 * `@deepseek-ai/*` package, so the entry module can be mounted straight from a profile's
 * `plugins/` directory, where Node's own ESM resolver cannot see the harness's node_modules.
 *
 * @module dsh-bubble/src/host/index
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerCodeAgent } from './code-agent.js'
import { resolveConfig } from './config.js'
import { DesktopProcessController } from './desktop.js'
import { SseHub } from './http.js'
import { BubbleConversation } from './bubble.js'
import { registerRoutes } from './routes.js'
import { BubbleStore } from './store.js'

/** Cordis plugin name. */
export const name = 'dsh-bubble'

/** Services the plugin cannot work without; `tools` and `workspaceRegistry` stay optional. */
export const inject = ['sessions', 'sessionController', 'webServer']

/** Absolute plugin package root, used to locate the desktop shell executable. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Environment handed to the desktop shell so it can place the ball and reach the plugin.
 * @param options - Web server port, normalized config, state store, and the per-launch token.
 * @returns Environment overrides for the child process.
 */
function shellEnvironment({ port, config, store, token }) {
  const window = store.window()
  const environment = {
    BUBBLE_API_BASE: `http://127.0.0.1:${port}${config.basePath}`,
    BUBBLE_TOKEN: token,
    BUBBLE_LOCALE: store.prefs().locale,
    BUBBLE_DIRECTION_H: window.direction.horizontal,
    BUBBLE_DIRECTION_V: window.direction.vertical,
    BUBBLE_SELECTION_TOOLBAR: config.selectionToolbar ? '1' : '0',
    BUBBLE_LOG_FILE: join(config.stateDir, 'shell.log'),
  }
  if (window.ball !== null && typeof window.ball.x === 'number' && typeof window.ball.y === 'number') {
    environment.BUBBLE_BALL_X = String(Math.round(window.ball.x))
    environment.BUBBLE_BALL_Y = String(Math.round(window.ball.y))
  }
  if (window.docked !== null) environment.BUBBLE_DOCKED = window.docked
  return environment
}

/**
 * Mount the floating ball.
 * @param ctx - Host context with `sessions`, `sessionController`, and `webServer` injected.
 * @param rawConfig - Raw config row from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger(name)
  // A configured token makes the endpoint deterministic for tests; the shipped default is random
  // per host start, so nothing on disk can be replayed against the ball's API.
  const token = config.token === '' ? randomUUID().replaceAll('-', '') : config.token

  const store = new BubbleStore(config.stateDir)
  const conversation = new BubbleConversation({ ctx, config, store, logger })
  const hub = new SseHub(token, () => conversation.snapshot())
  conversation.attach(hub)
  const desktop = new DesktopProcessController({
    packageRoot: PACKAGE_ROOT,
    configured: config.desktopExecutable,
    logFile: join(config.stateDir, 'shell.log'),
    logger,
  })

  ctx.effect(() => {
    let active = true
    void (async () => {
      await store.ready()
      if (!active) return
      await conversation.ready()
      if (!active) return
      desktop.setEnvironment(shellEnvironment({
        port: ctx.webServer.port,
        config,
        store,
        token,
      }))
      if (!active || !config.autoStart) return
      await desktop.setDesiredRunning(true)
    })().catch((error) => {
      logger.warn('dsh-bubble: initialization failed', error)
    })
    return () => {
      active = false
      desktop.dispose()
      hub.close()
    }
  }, 'dsh-bubble.lifecycle')

  ctx.effect(() => registerRoutes({
    ctx,
    config,
    conversation,
    store,
    hub,
    desktop,
    token,
    logger,
  }), 'dsh-bubble.routes')

  ctx.effect(() => {
    const heartbeat = setInterval(() => hub.ping(), 15_000)
    return () => clearInterval(heartbeat)
  }, 'dsh-bubble.heartbeat')

  ctx.on('session/event', (session, event) => conversation.onSessionEvent(session, event))
  ctx.on('agent/assistant-stream', (payload) => conversation.onStream(payload))
  ctx.on('agent/status', (payload) => conversation.onStatus(payload))

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () => registerCodeAgent(scope, conversation, logger),
      'dsh-bubble.code-agent',
    )
  })
}
