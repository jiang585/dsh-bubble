/**
 * Smoke-test the plugin against a fake harness: mount it, drive its HTTP surface, and assert the
 * harness calls it makes. This runs before anything touches a live profile.
 *
 * Run with the bundled Node: `node scripts/smoke-host.mjs`
 *
 * @module dsh-bubble/scripts/smoke-host
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/host/index.js'

const TOKEN = 'test-token'

/** One recorded harness call. */
const calls = {
  created: [],
  prompts: [],
  cancels: [],
  tools: [],
  workspaces: [],
  windows: [],
}

/** A fake session with a scripted transcript. */
function fakeSession(id, cwd, messages = []) {
  return {
    id,
    header: { cwd, agentPreset: 'standard', title: '球上对话', createdAt: 1 },
    deriveMessages: () => messages,
  }
}

/** Build the fake Cordis context the plugin mounts on. */
function fakeContext({ sessionId = 'sess-1' } = {}) {
  const sessions = new Map()
  sessions.set(sessionId, fakeSession(sessionId, join(process.env.DSH_HOME ?? tmpdir(), 'dsh_bubble')))
  const routes = []
  const effects = []
  /** Event name to handlers, so the test can drive the plugin the way the host does. */
  const handlers = new Map()
  const agents = new Map()

  const ctx = {
    logger: () => ({ warn: () => {} }),
    effect: (execute) => {
      const dispose = execute()
      effects.push(dispose)
      return { dispose }
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit: (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    get: (service) => {
      if (service === 'workspaceRegistry') return ctx.workspaceRegistry
      if (service === 'agents') return ctx.agents
      return undefined
    },
    inject: (services, callback) => {
      const scope = { ...ctx }
      for (const service of services) scope[service] = ctx[service]
      scope.effect = ctx.effect
      callback(scope)
    },
    sessions: {
      get: (id) => sessions.get(String(id)),
      list: () => [...sessions.values()],
    },
    sessionController: {
      create: async (request) => {
        calls.created.push(request)
        const id = `sess-${calls.created.length + 1}`
        sessions.set(id, fakeSession(id, request.cwd ?? join(process.env.DSH_HOME ?? tmpdir(), 'dsh_bubble')))
        agents.set(id, { id, status: 'idle', session: sessions.get(id), whenIdle: async () => {} })
        return { sessionId: id }
      },
      prompt: async (request) => {
        calls.prompts.push(request)
        return { accepted: true }
      },
      cancel: async (request) => {
        calls.cancels.push(request)
        return { accepted: true }
      },
    },
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
    },
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async (path, title) => {
        calls.workspaces.push({ path, title })
        return { id: 'ws-1', path, title }
      },
    },
    tools: {
      register: (definition) => {
        calls.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      port: 19387,
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    routes,
    effects,
  }
  return ctx
}

/**
 * Open the SSE route without awaiting it.
 *
 * The stream never ends on its own, so the handler is invoked while its output is collected into a
 * buffer this helper can read; that is how the smoke test observes what the panel would receive.
 *
 * @param ctx - Fake harness context carrying the registered routes.
 * @param token - Token the request presents.
 * @returns Object with `text()` for everything written so far.
 */
function openEventStream(ctx, token) {
  const route = ctx.routes.find((candidate) => candidate.path === '/dsh-bubble/events')
  assert.ok(route, 'the events route is missing')
  let text = ''
  const req = {
    method: 'GET',
    url: `/dsh-bubble/events?token=${token}`,
    headers: { origin: 'http://tauri.localhost' },
    socket: { setKeepAlive: () => {} },
    once: () => {},
    async *[Symbol.asyncIterator]() {},
  }
  const res = {
    setHeader: () => {},
    writeHead: () => {},
    write: (chunk) => {
      text += chunk
    },
    end: (chunk) => {
      if (chunk !== undefined) text += chunk
    },
  }
  void Promise.resolve(route.handler(req, res)).catch(() => {})
  return { text: () => text }
}

/** Call one registered route with a fake request. */async function callRoute(ctx, path, { method = 'GET', body, token = TOKEN } = {}) {
  const route = ctx.routes.find((candidate) => (
    candidate.kind === 'exact' ? candidate.path === path : path.startsWith(candidate.path)
  ))
  assert.ok(route, `no route registered for ${path} (have ${ctx.routes.map((r) => r.path).join(', ')})`)

  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    headers: { 'x-bubble-token': token, origin: 'http://tauri.localhost' },
    socket: { setKeepAlive: () => {} },
    once: () => {},
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
  let status = 0
  let headers = {}
  let text = ''
  const res = {
    setHeader: (key, value) => {
      headers[key.toLowerCase()] = value
    },
    writeHead: (code, extra) => {
      status = code
      Object.assign(headers, extra ?? {})
    },
    write: (chunk) => {
      text += chunk
    },
    end: (chunk) => {
      if (chunk !== undefined) text += chunk
    },
  }
  await route.handler(req, res)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status, headers, text, json }
}

const stateDir = await mkdtemp(join(tmpdir(), 'dsh-bubble-smoke-'))
process.env.DSH_HOME = stateDir

try {
  const ctx = fakeContext()
  assert.equal(name, 'dsh-bubble')
  apply(ctx, { stateDir: join(stateDir, 'state'), basePath: '/dsh-bubble', autoStart: false, token: TOKEN })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const paths = ctx.routes.map((route) => route.path).sort()
  assert.ok(paths.includes('/dsh-bubble/state'), `routes: ${paths.join(', ')}`)
  assert.ok(paths.includes('/dsh-bubble/events'), `routes: ${paths.join(', ')}`)
  assert.ok(ctx.routes.some((route) => route.kind === 'prefix'), 'static prefix route missing')

  const unauthorized = await callRoute(ctx, '/dsh-bubble/state', { token: 'wrong' })
  assert.equal(unauthorized.status, 403, 'a wrong token must be refused')

  // The ball runs on the Tauri origin and sends x-bubble-token, so every API call is preflighted.
  const preflightResponse = await callRoute(ctx, '/dsh-bubble/message', { method: 'OPTIONS' })
  assert.equal(preflightResponse.status, 204, 'OPTIONS must be answered, not refused')
  assert.equal(preflightResponse.headers['access-control-allow-origin'], 'http://tauri.localhost')
  assert.ok(
    String(preflightResponse.headers['access-control-allow-methods'] ?? '').includes('POST'),
    'the preflight must allow the route method',
  )
  assert.ok(
    String(preflightResponse.headers['access-control-allow-headers'] ?? '').includes('x-bubble-token'),
    'the preflight must allow the token header',
  )

  const state = await callRoute(ctx, '/dsh-bubble/state')
  assert.equal(state.status, 200, state.text)
  assert.equal(state.headers['access-control-allow-origin'], 'http://tauri.localhost')
  assert.equal(state.json.sessionId, 'sess-1')
  assert.deepEqual(state.json.messages, [])
  assert.equal(Array.isArray(state.json.history), true)
  assert.equal(state.json.history.length, 1, 'the live bubble session is history')

  const sent = await callRoute(ctx, '/dsh-bubble/message', { method: 'POST', body: { text: '你好' } })
  assert.equal(sent.status, 200, sent.text)
  assert.deepEqual(sent.json, { accepted: true })
  assert.equal(calls.prompts.length, 1)
  assert.equal(calls.prompts[0].sessionId, 'sess-1')
  assert.equal(calls.prompts[0].mode, 'queue')
  assert.deepEqual(calls.prompts[0].content, [{ type: 'text', text: '你好' }])
  assert.ok(calls.prompts[0].requestId.startsWith('bubble-'))

  const empty = await callRoute(ctx, '/dsh-bubble/message', { method: 'POST', body: { text: '   ' } })
  assert.equal(empty.status, 500, 'an empty message is refused')

  const cancelled = await callRoute(ctx, '/dsh-bubble/cancel', { method: 'POST' })
  assert.deepEqual(cancelled.json, { accepted: true })
  assert.deepEqual(calls.cancels, [{ sessionId: 'sess-1' }])

  const created = await callRoute(ctx, '/dsh-bubble/new', { method: 'POST' })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.sessionId, 'sess-2')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].agentPreset, 'standard')
  assert.equal(calls.created[0].workspaceId, 'ws-1', 'the bubble workspace is reused once registered')
  assert.equal(calls.workspaces.length, 1)
  assert.equal(calls.workspaces[0].title, 'dsh_bubble')

  const geometry = await callRoute(ctx, '/dsh-bubble/geometry', {
    method: 'POST',
    body: { ball: { x: 1848, y: 900 }, direction: { horizontal: 'left', vertical: 'up' }, docked: null },
  })
  assert.deepEqual(geometry.json, { saved: true })

  const badSelect = await callRoute(ctx, '/dsh-bubble/select', { method: 'POST', body: { sessionId: 'nope' } })
  assert.equal(badSelect.status, 500, 'a foreign session is refused')

  const wrongMethod = await callRoute(ctx, '/dsh-bubble/state', { method: 'POST' })
  assert.equal(wrongMethod.status, 405)

  assert.equal(calls.tools.length, 1, 'code_agent is registered')
  const tool = calls.tools[0]
  assert.equal(tool.name, 'code_agent')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['task'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')

  const toolResult = await tool.execute(
    { task: '做一个网站' },
    { signal: new AbortController().signal, agent: { id: 'sess-1' } },
  )
  assert.equal(toolResult.accepted, true)
  assert.equal(toolResult.created, true)
  assert.equal(calls.prompts.length, 2)
  assert.equal(calls.prompts[1].mode, 'queue')
  assert.equal(calls.prompts[1].content[0].text, '做一个网站')

  const rendered = tool.output.render({ task: '做一个网站' }, toolResult)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes(toolResult.session_id))

  await assert.rejects(async () => await tool.execute({ task: '  ' }, { signal: new AbortController().signal }))

  // Live assistant text must reach the page as incremental deltas, tagged text vs reasoning, and a
  // stale revision must be dropped. The page sees them over the SSE route, so assert there.
  const stream = openEventStream(ctx, TOKEN)
  await new Promise((resolve) => setTimeout(resolve, 30))

  // The ball moved to sess-2 when /new was called, and deltas are filtered by session.
  const agent = ctx.sessions.get('sess-2')
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', revision: 7, turn: 1, step: 1 } })
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', revision: 7, index: 0, chunk: { type: 'reasoning-delta', index: 0, text: '考虑一下' } } })
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', revision: 7, index: 1, chunk: { type: 'text-delta', index: 1, text: '# 标题\n' } } })
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', revision: 7, index: 1, chunk: { type: 'text-delta', index: 1, text: '公式 $a^2$' } } })
  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', revision: 6, index: 1, chunk: { type: 'text-delta', index: 1, text: '不应出现' } } })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const frames = stream
    .text()
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type === 'delta')

  assert.equal(frames.length, 3, `expected three deltas, got ${JSON.stringify(frames)}`)
  assert.equal(frames[0].kind, 'reasoning')
  assert.equal(frames[0].id, 'bubble-stream')
  assert.equal(frames[1].kind, 'text')
  assert.equal(frames[2].text, '公式 $a^2$')
  assert.ok(!frames.some((event) => event.text.includes('不应出现')), 'a stale revision must be dropped')

  ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', revision: 7, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } })

  // A pending `ask_user_question` must be surfaced to the page: it is the only host-side signal that
  // the agent is blocked on the user, and the ball cannot answer it itself.
  const questionFrames = () => stream
    .text()
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((frame) => frame.type === 'question')

  /** Emit one durable session event the way the host does. */
  const session = ctx.sessions.get('sess-2')
  const emitSession = (data) => ctx.emit('session/event', session, { id: data.seq ?? 1, type: data.type, data: data.data })

  emitSession({
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          {
            id: 'deploy',
            header: '确认',
            question: '要部署到生产环境吗？',
            options: [{ label: '是' }, { label: '否', description: '再等等' }],
          },
        ],
      }),
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const asked = questionFrames().at(-1)
  assert.ok(asked !== undefined, 'a pending question must be published')
  assert.equal(asked.question.callId, 'call-1')
  assert.equal(asked.question.questions.length, 1)
  assert.equal(asked.question.questions[0].question, '要部署到生产环境吗？')
  assert.equal(asked.question.questions[0].header, '确认')
  assert.deepEqual(asked.question.questions[0].options, [
    { label: '是' },
    { label: '否', description: '再等等' },
  ])
  const withQuestion = await callRoute(ctx, '/dsh-bubble/state')
  assert.equal(withQuestion.json.question.callId, 'call-1', 'a reopened panel must see the question')

  // A malformed argument string must not take the plugin down.
  emitSession({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-2', name: 'ask_user_question', arguments: '{not json' },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const broken = questionFrames().at(-1)
  assert.equal(broken.question.callId, 'call-2')
  assert.deepEqual(broken.question.questions, [], 'an unparsable call yields an empty question list')

  // The result retires it, so a reopened panel does not show a stale question.
  emitSession({ type: 'tool/result', data: { callId: 'call-2', outcome: 'ok' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(questionFrames().at(-1).question, null)
  const reopened = await callRoute(ctx, '/dsh-bubble/state')
  assert.equal(reopened.json.question, null, 'the snapshot must not carry a resolved question')

  // Dispose every mounted effect so the heartbeat timer cannot keep this process alive.
  for (const dispose of ctx.effects.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }

  console.log('dsh-bubble host smoke: ok')
} finally {
  await rm(stateDir, { recursive: true, force: true })
}
