/**
 * Stub the plugin's HTTP surface so the ball window can be exercised without a running harness.
 *
 * It answers the same routes the plugin registers, prints every request, and pushes a scripted
 * transcript over SSE, which proves the cross-origin fetch, the per-launch token, and EventSource
 * all work from inside the Tauri window.
 *
 * `node scripts/stub-api.mjs [port]`
 *
 * @module dsh-bubble/scripts/stub-api
 */

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 19399)
const base = '/dsh-bubble'
const token = process.env.BUBBLE_TOKEN ?? 'dev-token'

/** Transcript pushed to every connected ball. */
const messages = [
  { id: 'u1', role: 'user', text: '帮我看看这个项目' },
  {
    id: 'a1',
    role: 'assistant',
    text: '我先看了仓库结构，这是一个 **dsh 插件**。\n\n- 宿主半边：`src/host`\n- 悬浮窗：`desktop/`\n\n需要我继续吗？',
  },
  { id: 't1', role: 'tool', name: 'bash', summary: 'git log --oneline -5', detail: '72f1d73 fix(bubble): default millifraction coordinates' },
]

const clients = new Set()

/** Answer JSON with CORS, mirroring the plugin. */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-bubble-token',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

/** Read a JSON body. */
async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const presented = req.headers['x-bubble-token'] ?? url.searchParams.get('token') ?? ''
  const stamp = new Date().toISOString().slice(11, 23)
  const interesting = ['origin', 'access-control-request-method', 'access-control-request-headers', 'content-type', 'user-agent']
  const headers = interesting
    .filter((key) => req.headers[key] !== undefined)
    .map((key) => `${key}=${req.headers[key]}`)
    .join(' ')
  console.log(`${stamp} ${req.method} ${path} token=${presented === token ? 'ok' : 'MISSING'} ${headers}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-bubble-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    res.end()
    return
  }
  if (!path.startsWith(base)) {
    res.writeHead(404)
    res.end()
    return
  }
  if (presented !== token) {
    json(res, 403, { error: 'Invalid token' })
    return
  }

  const route = path.slice(base.length)
  if (route === '/state') {
    json(res, 200, { sessionId: 'stub-1', running: false, theme: 'light', messages, history: [{ id: 'stub-1', title: '桩会话' }] })
    return
  }
  if (route === '/history') {
    json(res, 200, [{ id: 'stub-1', title: '桩会话' }])
    return
  }
  if (route === '/events') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    clients.add(res)
    console.log('SSE client connected')
    res.write(`event: bubble\ndata: ${JSON.stringify({ type: 'status', running: true })}\n\n`)
    setTimeout(() => {
      res.write(`event: bubble\ndata: ${JSON.stringify({ type: 'delta', id: 'stream-1', text: '正在流式输出…' })}\n\n`)
      console.log('SSE delta pushed')
    }, 1500)
    req.once('close', () => {
      clients.delete(res)
      console.log('SSE client disconnected')
    })
    return
  }
  if (route === '/message' && req.method === 'POST') {
    console.log('message body:', JSON.stringify(await body(req)))
    json(res, 200, { accepted: true })
    return
  }
  if (route === '/geometry' && req.method === 'POST') {
    console.log('geometry body:', JSON.stringify(await body(req)))
    json(res, 200, { saved: true })
    return
  }
  if (route === '/cancel' || route === '/new' || route === '/select' || route === '/theme' || route === '/selection') {
    json(res, 200, { accepted: true })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-bubble stub listening on http://127.0.0.1:${port}${base} (token ${token})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const client of clients) client.end()
    server.close(() => process.exit(0))
  })
}
