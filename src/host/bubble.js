/**
 * The ball's conversation: one front session on the bubble workspace, its transcript, and its stream.
 *
 * `ctx.sessionController` drives every session operation because it activates the Agent behind the
 * session; `ctx.sessions` only exposes the Session object. The transcript is re-derived from
 * `session.deriveMessages()` whenever a durable event lands, and live assistant text comes from
 * `agent/assistant-stream` frames, which never reach the session log.
 *
 * @module dsh-bubble/src/host/bubble
 */

import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Longest tool detail forwarded to the ball, in characters. */
const TOOL_DETAIL_LIMIT = 4000

/** First line of a tool payload, used as the collapsed row label. */
function firstLine(text) {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Bound one tool payload for the ball's panel. */
function clip(text) {
  return text.length <= TOOL_DETAIL_LIMIT ? text : `${text.slice(0, TOOL_DETAIL_LIMIT - 1)}…`
}

/** Joined text blocks of one message. */
function textOf(content) {
  return (content ?? [])
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** One zeroed token-usage tally. */
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/** Workspace directory names this ball used before it was renamed. */
const LEGACY_WORKSPACE_NAMES = ['dsh_orb']

/**
 * Whether a session cwd is inside one of the ball's workspaces.
 *
 * @param cwd - `session.header.cwd`, possibly undefined for foreign sessions.
 * @param directories - Workspace roots, the current one first.
 * @returns True when the session belongs to the ball.
 */
function sessionCwdBelongs(cwd, directories) {
  if (typeof cwd !== 'string') return false
  return directories.some((directory) => (
    cwd === directory || cwd.startsWith(`${directory}\\`) || cwd.startsWith(`${directory}/`)
  ))
}

/**
 * Add one provider-reported `TokenUsage` into a tally.
 * @param tally - Mutable tally to add into.
 * @param usage - `TokenUsage` from an `assistant/message` event.
 */
function addUsage(tally, usage) {
  tally.input += usage?.inputTokens ?? 0
  tally.output += usage?.outputTokens ?? 0
  tally.cacheRead += usage?.cacheReadTokens ?? 0
  tally.cacheWrite += usage?.cacheWriteTokens ?? 0
  tally.total += usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
}

/**
 * Fold one conversation into the compact rows the ball renders.
 * @param messages - Messages from `session.deriveMessages()`.
 * @returns Wire rows in conversation order.
 */
export function transcriptRows(messages) {
  const rows = []
  for (const message of messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') continue
    // User-role messages also carry harness-injected context, the skill catalog among them. Only a
    // message the human actually sent has `source.kind === 'user'`.
    if (message.role === 'user' && message.source?.kind !== 'user') continue
    const text = textOf(message.content).trim()
    if (message.role === 'tool') {
      rows.push({
        id: String(message.id),
        role: 'tool',
        name: '工具结果',
        summary: firstLine(text),
        detail: clip(text),
      })
      continue
    }
    for (const block of message.content ?? []) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
      const detail = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
      rows.push({
        id: `${String(message.id)}:${String(block.id ?? block.name ?? rows.length)}`,
        role: 'tool',
        name: String(block.name ?? 'tool'),
        summary: firstLine(detail),
        detail: clip(detail),
      })
    }
    if (text !== '') rows.push({ id: String(message.id), role: message.role, text })
  }
  return rows
}

/**
 * Owns the ball's front session, its history, and the live stream forwarded to the window.
 */
export class BubbleConversation {
  #ctx
  #config
  #store
  #logger
  #hub
  #directory
  /**
   * Every directory whose sessions belong to this ball.
   *
   * The workspace was renamed from `dsh_orb` to `dsh_bubble`; session headers pin the directory they
   * were created in, so the old path stays accepted and the conversations made before the rename
   * keep showing up in 历史 instead of silently disappearing.
   */
  #directories = []
  #workspaceId
  #sessionId
  #running = false
  #stream = undefined
  #usage = { turn: emptyUsage(), session: emptyUsage() }
  #titles = new Map()
  /** Pending `ask_user_question` call the agent is waiting on, when there is one. */
  #question = null

  /**
   * @param options - Host context, normalized config, state store, and a warning sink.
   */
  constructor({ ctx, config, store, logger }) {
    this.#ctx = ctx
    this.#config = config
    this.#store = store
    this.#logger = logger
    this.#directory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), config.workspaceName)
    this.#directories = [
      this.#directory,
      // Pre-rename workspace: sessions created before the rename still carry this cwd.
      ...LEGACY_WORKSPACE_NAMES.map((name) => join(dirname(this.#directory), name)),
    ]
  }

  /**
   * Attach the event fan-out the conversation publishes to.
   * @param hub - SSE hub with `broadcast(payload)`.
   */
  attach(hub) {
    this.#hub = hub
  }

  /** Absolute directory that owns the ball's sessions. */
  directory() {
    return this.#directory
  }

  /** Active front session id, when one exists. */
  sessionId() {
    return this.#sessionId
  }

  /** Publish one event to the ball. */
  #publish(payload) {
    this.#hub?.broadcast(payload)
  }

  /**
   * Record or clear the agent's pending question.
   *
   * @param callId - Tool call the question belongs to, or undefined to clear it.
   * @param rawArguments - The tool call's JSON argument string.
   */
  #setQuestion(callId, rawArguments) {
    if (callId === undefined) {
      if (this.#question === null) return
      this.#question = null
      this.#publish({ type: 'question', question: null })
      return
    }
    let questions = []
    try {
      const parsed = JSON.parse(String(rawArguments ?? '{}'))
      if (Array.isArray(parsed?.questions)) {
        questions = parsed.questions.map((item) => ({
          id: String(item?.id ?? ''),
          question: String(item?.question ?? ''),
          ...(typeof item?.header === 'string' ? { header: item.header } : {}),
          ...(item?.multiSelect === true ? { multiSelect: true } : {}),
          options: Array.isArray(item?.options)
            ? item.options.map((option) => ({
                label: String(option?.label ?? ''),
                ...(typeof option?.description === 'string' ? { description: option.description } : {}),
              }))
            : [],
        }))
      }
    } catch (error) {
      this.#logger.warn('dsh-bubble: cannot parse an ask_user_question call', error)
    }
    this.#question = { callId: String(callId), questions }
    this.#publish({ type: 'question', question: this.#question })
  }

  /** Zero both usage tallies, for a new or switched conversation. */
  #resetUsage() {
    this.#usage = { turn: emptyUsage(), session: emptyUsage() }
  }

  /** Resolve the bubble workspace, creating its directory and registry row on first use. */
  async ready() {
    await mkdir(this.#directory, { recursive: true })
    let canonical = this.#directory
    try {
      canonical = await realpath(this.#directory)
    } catch (error) {
      this.#logger.warn('dsh-bubble: cannot canonicalize the bubble workspace directory', error)
    }
    const registry = this.#ctx.get('workspaceRegistry')
    if (registry === undefined) {
      this.#logger.warn('dsh-bubble: no workspace registry; sessions fall back to a plain cwd')
      return
    }
    try {
      const existing = await registry.resolveByPath(canonical)
      this.#workspaceId = existing?.id
      if (existing === undefined) {
        const created = await registry.create(canonical, this.#config.workspaceName)
        this.#workspaceId = created.id
      }
    } catch (error) {
      this.#logger.warn('dsh-bubble: cannot register the bubble workspace', error)
    }
    const stored = this.#store.sessionId()
    if (stored !== null && this.#isBubbleSession(stored)) {
      this.#sessionId = stored
      return
    }
    const adopted = this.#latestBubbleSession()
    if (adopted !== undefined) {
      this.#sessionId = adopted
      await this.#store.setSession(adopted)
      return
    }
    // Create the front session eagerly: the ball's History lists real sessions, so an unused ball
    // must still own one, and the window has a transcript target from the first paint.
    try {
      await this.ensureSession()
    } catch (error) {
      this.#logger.warn('dsh-bubble: cannot create the front session', error)
    }
  }

  /** Newest live front session in the bubble workspace, used when no id was persisted. */
  #latestBubbleSession() {
    let newest
    for (const session of this.#ctx.sessions.list()) {
      if (session.header?.agentPreset !== this.#config.frontPreset) continue
      if (!this.#isBubbleSession(session.id)) continue
      if (newest === undefined || (session.header?.createdAt ?? 0) > (newest.header?.createdAt ?? 0)) {
        newest = session
      }
    }
    return newest === undefined ? undefined : String(newest.id)
  }

  /** Whether one live session belongs to the bubble workspace. */
  #isBubbleSession(sessionId) {
    const session = this.#ctx.sessions.get(sessionId)
    if (session === undefined) return false
    return sessionCwdBelongs(session.header?.cwd, this.#directories)
  }

  /** Live front session, when the stored id still resolves. */
  #session() {
    if (this.#sessionId === undefined) return undefined
    return this.#ctx.sessions.get(this.#sessionId)
  }

  /** Create the front session on first use. */
  async ensureSession() {
    const live = this.#session()
    if (live !== undefined) return live
    const request = { agentPreset: this.#config.frontPreset }
    if (this.#workspaceId !== undefined) request.workspaceId = this.#workspaceId
    else request.cwd = this.#directory
    const created = await this.#ctx.sessionController.create(request)
    this.#sessionId = created.sessionId
    await this.#store.setSession(this.#sessionId)
    this.#resetUsage()
    await this.#applyStoredModel()
    this.#publish({ type: 'reset', sessionId: String(this.#sessionId) })
    return this.#session()
  }

  /** Apply the ball's persisted model choice to a freshly created session. */
  async #applyStoredModel() {
    const selection = this.#store.model()
    if (selection === null || this.#sessionId === undefined) return
    try {
      await this.#ctx.sessionController.selectModel({
        sessionId: this.#sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        saveAsDefault: false,
      })
    } catch (error) {
      this.#logger.warn('dsh-bubble: cannot apply the stored model to the ball session', error)
    }
  }

  /** Provider groups the ball can choose from, plus the current choice. */
  async models() {
    const catalog = await this.#ctx.sessionController.modelCatalog()
    return {
      groups: catalog.groups ?? [],
      failures: catalog.failures ?? [],
      default: catalog.default ?? null,
      selected: this.#store.model(),
    }
  }

  /**
   * Select the model for the ball's conversation.
   * @param choice - `{ provider, model, reasoningEffort? }` from the panel.
   */
  async selectModel(choice) {
    await this.ensureSession()
    const selection = {
      provider: String(choice?.provider ?? ''),
      model: String(choice?.model ?? ''),
      ...(typeof choice?.reasoningEffort === 'string' ? { reasoningEffort: choice.reasoningEffort } : {}),
    }
    if (selection.provider === '' || selection.model === '') throw new Error('模型选择不完整')
    await this.#ctx.sessionController.selectModel({
      sessionId: this.#sessionId,
      ...selection,
      saveAsDefault: false,
    })
    await this.#store.setModel(selection)
    this.#publish({ type: 'state', state: this.snapshot() })
    return selection
  }

  /** Send one user message to the ball's session. */
  async send(text) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') throw new Error('消息不能为空')
    await this.ensureSession()
    const requestId = `bubble-${randomUUID()}`
    await this.#ctx.sessionController.prompt(
      {
        requestId,
        sessionId: this.#sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: trimmed }],
      },
      new AbortController().signal,
    )
    return { accepted: true }
  }

  /** Cancel the running turn, keeping queued messages. */
  async cancel() {
    if (this.#sessionId === undefined) return { accepted: true }
    return await this.#ctx.sessionController.cancel({ sessionId: this.#sessionId })
  }

  /** Start a fresh front session and switch the ball to it. */
  async newSession() {
    this.#sessionId = undefined
    this.#running = false
    await this.ensureSession()
    return { sessionId: String(this.#sessionId) }
  }

  /**
   * Switch the ball to another bubble session.
   * @param sessionId - Candidate id; must belong to the bubble workspace.
   */
  async select(sessionId) {
    if (typeof sessionId !== 'string' || !this.#isBubbleSession(sessionId)) {
      throw new Error('该会话不属于悬浮球工作区')
    }
    this.#sessionId = sessionId
    await this.#store.setSession(sessionId)
    this.#resetUsage()
    const agent = this.#ctx.get('agents')?.get(sessionId)
    this.#running = agent?.status === 'running'
    this.#publish({ type: 'state', state: this.snapshot() })
    return { sessionId }
  }

  /** Ball sessions, newest first, titled the way the main window titles them. */
  async history() {
    const titles = this.#ctx.get('sessionTitle')
    const front = []
    for (const session of this.#ctx.sessions.list()) {
      if (!sessionCwdBelongs(session.header?.cwd, this.#directories)) continue
      if (session.header?.agentPreset !== this.#config.frontPreset) continue
      let title = this.#titles.get(String(session.id))
      if (title === undefined) {
        try {
          title = this.#ctx.get('sessionTitle')?.get(session)?.title
        } catch (error) {
          this.#logger.warn('dsh-bubble: cannot read a session title', error)
        }
      }
      front.push({
        id: String(session.id),
        title: title ?? session.header?.title ?? shortId(session.id),
        updatedAt: session.header?.createdAt ?? 0,
      })
    }
    front.sort((left, right) => right.updatedAt - left.updatedAt)
    return front
  }

  /** Complete state the ball renders from. */
  snapshot() {
    const session = this.#session()
    return {
      sessionId: this.#sessionId === undefined ? null : String(this.#sessionId),
      running: this.#running,
      theme: this.#store.prefs().theme,
      model: this.#store.model(),
      usage: { turn: { ...this.#usage.turn }, session: { ...this.#usage.session } },
      question: this.#question,
      messages: session === undefined ? [] : transcriptRows(session.deriveMessages()),
      history: [],
    }
  }

  /** Full transcript of the active session. */
  transcript() {
    const session = this.#session()
    return session === undefined ? [] : transcriptRows(session.deriveMessages())
  }

  /**
   * Show one plugin notice on the ball, for example a finished background task.
   * @param notice - Notice text plus the background session that produced it.
   */
  notify({ text, sessionId, callerId }) {
    this.#publish({
      type: 'append',
      message: {
        id: `notice-${sessionId}-${Date.now()}`,
        role: 'notice',
        text,
      },
    })
    void callerId
  }

  /**
   * Republish the transcript after a durable event on the active session.
   * @param session - Session that emitted the event.
   * @param event - Durable event envelope.
   */
  onSessionEvent(session, event) {    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      this.#titles.set(String(session.id), event.data.title)
    }
    if (this.#sessionId === undefined || String(session.id) !== String(this.#sessionId)) return
    if (typeof event?.type === 'string' && event.type.startsWith('request/')) return
    if (event?.type === 'turn/start') {
      this.#usage.turn = emptyUsage()
      this.#setRunning(true)
      this.#publish({ type: 'usage', usage: { turn: { ...this.#usage.turn }, session: { ...this.#usage.session } } })
    }
    // A pending `ask_user_question` call is the only host-side signal that the agent is blocked on
    // the user. The answering surface itself belongs to the DSH window (the `userQuestions` service
    // allows a single provider and the window owns it), so the ball reports the question and points
    // the user at the window instead of pretending to answer it.
    if (event?.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      this.#setQuestion(event.data.callId, event.data.arguments)
    }
    if (event?.type === 'tool/result' && this.#question !== null && String(event.data?.callId) === this.#question.callId) {
      this.#setQuestion(undefined, undefined)
    }
    if (event?.type === 'turn/end') {
      this.#setRunning(false)
      if (this.#question !== null) this.#setQuestion(undefined, undefined)
    }
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      addUsage(this.#usage.turn, event.data.usage)
      addUsage(this.#usage.session, event.data.usage)
      this.#publish({ type: 'usage', usage: { turn: { ...this.#usage.turn }, session: { ...this.#usage.session } } })
    }
    this.#publish({ type: 'replace', messages: this.transcript() })
  }

  /**
   * Forward one live assistant frame as an incremental text event.
   * @param payload - `{ agent, frame }` from `agent/assistant-stream`.
   */
  onStream({ agent, frame }) {
    if (this.#sessionId === undefined || String(agent?.id) !== String(this.#sessionId)) return
    if (frame?.type === 'start') {
      this.#stream = { revision: frame.revision, text: '' }
      this.#setRunning(true)
      return
    }
    if (this.#stream === undefined || this.#stream.revision !== frame?.revision) return
    if (frame.type === 'chunk' && (frame.chunk?.type === 'text-delta' || frame.chunk?.type === 'reasoning-delta')) {
      const kind = frame.chunk.type === 'text-delta' ? 'text' : 'reasoning'
      if (kind === 'text') this.#stream.text += frame.chunk.text
      this.#publish({ type: 'delta', id: 'bubble-stream', kind, text: frame.chunk.text })
      return
    }
    if (frame.type === 'end') this.#stream = undefined
  }

  /**
   * Mirror one Agent status change.
   * @param payload - `{ agent, status }` from `agent/status`.
   */
  onStatus({ agent, status }) {
    if (this.#sessionId === undefined || String(agent?.id) !== String(this.#sessionId)) return
    this.#setRunning(status === 'running')
  }

  /** Publish a status change only when it actually changed. */
  #setRunning(running) {
    if (this.#running === running) return
    this.#running = running
    this.#publish({ type: 'status', running })
  }
}

/** Short display id for a session without a title. */
function shortId(id) {
  const text = String(id)
  return text.length <= 12 ? text : text.slice(0, 12)
}
