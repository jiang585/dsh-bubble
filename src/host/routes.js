/**
 * HTTP surface of the floating ball.
 *
 * Every route lives on the harness web server, so the DSH Web UI reaches it on the same origin and
 * the Tauri ball window reaches it cross-origin with CORS. API routes require the per-launch token
 * the shell received through its environment; the static route serves the ball's own assets.
 *
 * @module dsh-bubble/src/host/routes
 */

import { fileURLToPath } from 'node:url'
import {
  methodNotAllowed,
  preflight,
  presentedToken,
  readJsonBody,
  RequestError,
  sendJson,
  serveStatic,
} from './http.js'

/** Absolute directory holding the ball's HTML, CSS, and script. */
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url))

/**
 * Answer one thrown error with its status.
 * @param res - Node response.
 * @param error - Thrown value.
 * @param origin - Request `Origin` header.
 */
function fail(res, error, origin) {
  const status = error instanceof RequestError ? error.status : 500
  const message = error instanceof Error ? error.message : 'Unknown error'
  sendJson(res, status, { error: message }, origin)
}

/**
 * Register every ball route on the harness web server.
 * @param options - Host context, config, services, and the per-launch token.
 * @returns Disposer that removes every route.
 */
export function registerRoutes({ ctx, config, conversation, store, hub, desktop, token, logger }) {
  const base = config.basePath

  /** Reject a request that does not present the per-launch token. */
  const guard = (req, res, url) => {
    if (presentedToken(req, url) === token) return true
    sendJson(res, 403, { error: 'Invalid token' }, req.headers.origin)
    return false
  }

  /** Read the request URL. */
  const urlOf = (req) => new URL(req.url ?? '/', 'http://localhost')

  const json = (path, method, handler) => ctx.webServer.register({
    kind: 'exact',
    path: `${base}${path}`,
    handler: async (req, res) => {
      const url = urlOf(req)
      if (req.method === 'OPTIONS') {
        preflight(res, req.headers.origin, `${method}, OPTIONS`)
        return
      }
      if (req.method !== method) {
        methodNotAllowed(res, method, req.headers.origin)
        return
      }
      if (!guard(req, res, url)) {
        await store.noteRequest({ method: req.method, path, status: 403, origin: req.headers.origin ?? '' })
        return
      }
      try {
        const value = await handler(req, url)
        sendJson(res, 200, value, req.headers.origin)
        await store.noteRequest({ method: req.method, path, status: 200, origin: req.headers.origin ?? '' })
      } catch (error) {
        logger.warn(`dsh-bubble: ${path} failed`, error)
        fail(res, error, req.headers.origin)
        await store.noteRequest({
          method: req.method,
          path,
          status: error instanceof RequestError ? error.status : 500,
          origin: req.headers.origin ?? '',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  const disposers = [
    json('/state', 'GET', async () => ({
      ...conversation.snapshot(),
      history: await conversation.history(),
    })),

    json('/history', 'GET', () => conversation.history()),

    json('/message', 'POST', async (req) => {
      const body = await readJsonBody(req)
      return await conversation.send(body.text)
    }),

    json('/cancel', 'POST', () => conversation.cancel()),

    json('/new', 'POST', () => conversation.newSession()),

    json('/select', 'POST', async (req) => {
      const body = await readJsonBody(req)
      return await conversation.select(body.sessionId)
    }),

    json('/models', 'GET', () => conversation.models()),

    json('/model', 'POST', async (req) => {
      const body = await readJsonBody(req)
      return await conversation.selectModel(body)
    }),

    json('/geometry', 'POST', async (req) => {
      const body = await readJsonBody(req)
      if (typeof body.shellFailure === 'string' && body.shellFailure !== '') {
        await store.noteRequest({ method: 'POST', path: '/geometry', status: 200, origin: '', error: body.shellFailure })
      }
      await store.setWindow({
        ball: body.ball,
        direction: body.direction,
        docked: body.docked,
      })
      return { saved: true }
    }),

    json('/theme', 'POST', async (req) => {
      const body = await readJsonBody(req)
      await store.setPrefs({ theme: body.theme })
      hub.broadcast({ type: 'state', state: conversation.snapshot() })
      return { theme: store.prefs().theme }
    }),

    json('/selection', 'POST', async (req) => {
      const body = await readJsonBody(req)
      hub.broadcast({ type: 'selection', text: String(body.text ?? '') })
      return { shown: true }
    }),

    json('/restart-desktop', 'POST', async () => {
      desktop.stop()
      await desktop.setDesiredRunning(true)
      return { running: desktop.running() }
    }),

    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/events`,
      handler: (req, res) => {
        if (req.method === 'OPTIONS') {
          preflight(res, req.headers.origin, 'GET, OPTIONS')
          return
        }
        hub.handle(req, res, urlOf(req))
      },
    }),

    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (req, res) => serveStatic(req, res, base, WEB_ROOT),
    }),
  ]

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
