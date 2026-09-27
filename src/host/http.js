/**
 * HTTP plumbing for the floating ball: JSON endpoints, an SSE fan-out, and static files.
 *
 * The ball window runs on the Tauri origin, so every API response carries CORS headers and every
 * API request must present the per-launch token the plugin handed the shell through the
 * environment. The DSH Web UI shares the origin and needs no CORS, but uses the same token path so
 * one code path serves both.
 *
 * @module dsh-bubble/src/host/http
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** Content types served for the ball's static assets. */
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** Largest JSON request body the ball accepts, in bytes. */
const BODY_LIMIT = 256 * 1024

/** One rejected request with its HTTP status. */
export class RequestError extends Error {
  /** @param status - HTTP status to answer with. @param message - Operator-facing reason. */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Headers shared by every response.
 * @param res - Node response.
 * @param origin - Request `Origin` header, when present.
 */
function baseHeaders(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bubble-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
}

/**
 * Answer a JSON value.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param value - JSON-serializable body.
 * @param origin - Request `Origin` header.
 */
export function sendJson(res, status, value, origin) {
  const body = JSON.stringify(value)
  baseHeaders(res, origin)
  res.writeHead(status, {
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

/**
 * Answer a plain-text value.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - Response text.
 * @param origin - Request `Origin` header.
 */
export function sendText(res, status, body, origin) {
  baseHeaders(res, origin)
  res.writeHead(status, {
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8',
  })
  res.end(body)
}

/**
 * Answer a CORS preflight.
 *
 * The ball window runs on the Tauri origin and sends `x-bubble-token`, so every API request is
 * preflighted; without this the browser blocks the real request before the route ever runs.
 *
 * @param res - Node response.
 * @param origin - Request `Origin` header.
 * @param allow - Methods the route accepts.
 */
export function preflight(res, origin, allow) {
  baseHeaders(res, origin)
  res.setHeader('Access-Control-Allow-Methods', allow)
  res.setHeader('Access-Control-Max-Age', '600')
  res.writeHead(204)
  res.end()
}

/**
 * Answer 405 with the allowed methods.
 * @param res - Node response.
 * @param allow - `Allow` header value.
 * @param origin - Request `Origin` header.
 */
export function methodNotAllowed(res, allow, origin) {
  res.setHeader('Allow', allow)
  sendText(res, 405, 'Method not allowed', origin)
}

/**
 * Read and parse one JSON object body.
 * @param req - Node request.
 * @returns Parsed object.
 * @throws {RequestError} when the body is too large, malformed, or not an object.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > BODY_LIMIT) throw new RequestError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'Malformed JSON body')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError(400, 'Request body must be an object')
  }
  return parsed
}

/**
 * Read the per-launch token from the header the ball page sends, or the SSE query fallback.
 * @param req - Node request.
 * @param url - Parsed request URL.
 * @returns Presented token, or an empty string.
 */
export function presentedToken(req, url) {
  const header = req.headers['x-bubble-token']
  if (typeof header === 'string' && header !== '') return header
  return url.searchParams.get('token') ?? ''
}

/**
 * Server-sent event fan-out for one ball window generation.
 */
export class SseHub {
  #clients = new Set()
  #token
  #snapshot

  /**
   * @param token - Per-launch token every subscriber must present.
   * @param snapshot - Initial state payload.
   */
  constructor(token, snapshot) {
    this.#token = token
    this.#snapshot = snapshot
  }

  /**
   * Open one event stream.
   * @param req - Node request.
   * @param res - Node response.
   * @param url - Parsed request URL.
   */
  handle(req, res, url) {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET', req.headers.origin)
      return
    }
    if (presentedToken(req, url) !== this.#token) {
      sendJson(res, 403, { error: 'Invalid token' }, req.headers.origin)
      return
    }
    baseHeaders(res, req.headers.origin)
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    req.socket.setKeepAlive(true)
    this.#clients.add(res)
    this.send(res, { type: 'state', state: this.#snapshot() })
    req.once('close', () => {
      this.#clients.delete(res)
    })
  }

  /**
   * Send one event to every open stream.
   * @param payload - Event payload.
   */
  broadcast(payload) {
    for (const client of this.#clients) this.send(client, payload)
  }

  /** Keep intermediaries from closing an idle stream. */
  ping() {
    for (const client of this.#clients) client.write(': keepalive\n\n')
  }

  /** End every open stream. */
  close() {
    for (const client of this.#clients) client.end()
    this.#clients.clear()
  }

  /**
   * Write one named event.
   * @param res - One open stream.
   * @param payload - Event payload.
   */
  send(res, payload) {
    res.write(`event: bubble\ndata: ${JSON.stringify(payload)}\n\n`)
  }
}

/**
 * Serve one file from the package's `web/` directory.
 * @param req - Node request.
 * @param res - Node response.
 * @param basePath - Plugin mount path.
 * @param webRoot - Absolute `web/` directory.
 */
export async function serveStatic(req, res, basePath, webRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD', req.headers.origin)
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === basePath) {
    res.writeHead(308, { Location: `${basePath}/` })
    res.end()
    return
  }
  let relativePath
  try {
    relativePath = decodeURIComponent(pathname.slice(basePath.length + 1))
  } catch {
    sendText(res, 400, 'Malformed path', req.headers.origin)
    return
  }
  if (relativePath === '') relativePath = 'index.html'
  const root = resolve(webRoot)
  const filePath = resolve(root, relativePath)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendText(res, 403, 'Forbidden', req.headers.origin)
    return
  }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(filePath)
    baseHeaders(res, req.headers.origin)
    res.setHeader(
      'Cache-Control',
      relativePath === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    )
    res.writeHead(200, {
      'Content-Length': String(body.byteLength),
      'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    sendText(res, 404, 'Not found', req.headers.origin)
  }
}
