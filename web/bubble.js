/**
 * DSH Bubble ball renderer - Gemini Ultra-Modern Edition.
 *
 * Runs inside the Tauri ball window or in a browser. Delivers a clean, layered HUD with
 * non-destructive flyout drawers for Model & History selection, fluid token metrics, and stable
 * window lifecycle management without abrupt disappears or state desync.
 */
(() => {
  'use strict'

  const ANIMATION_MS = 240
  const COLLAPSE_DELAY_MS = 800
  const DRAG_THRESHOLD = 5

  /** Row id the host uses for live assistant text that has not reached the session log yet. */
  const STREAM_ID = 'bubble-stream'

  /**
   * Panel build stamp.
   *
   * `tauri.conf.json` embeds this file into the shell executable, so "the file on disk is current" says
   * nothing about the panel a running ball serves. Bump this whenever the panel changes: the shell
   * writes it to `~/.dsh/dsh-bubble/shell.log` at startup, which is the only reliable way to tell which
   * build a running ball actually loaded.
   */
  const PANEL_REVISION = '2026-09-28.5-lock-covers-classes'

  const tauri = window.__TAURI__
  const invoke = tauri?.core?.invoke
  const listen = tauri?.event?.listen
  const inDesktop = typeof invoke === 'function'

  // DOM Elements
  const panel = document.getElementById('panel')
  const transcript = document.getElementById('transcript')
  const prompt = document.getElementById('prompt')
  const composer = document.getElementById('composer')
  const sendButton = document.getElementById('send-btn')
  const ball = document.getElementById('ball')
  const stop = document.getElementById('stop')
  const historyButton = document.getElementById('history')
  const newButton = document.getElementById('new-conversation')
  const pinButton = document.getElementById('pin-button')
  const closePanelButton = document.getElementById('close-panel-btn')
  
  const modelButton = document.getElementById('model')
  const modelNameText = document.getElementById('model-name-text')
  const modelDrawer = document.getElementById('model-drawer')
  const modelList = document.getElementById('model-list')
  const closeModelDrawerBtn = document.getElementById('close-model-drawer')

  const historyDrawer = document.getElementById('history-drawer')
  const historyList = document.getElementById('history-list')
  const closeHistoryDrawerBtn = document.getElementById('close-history-drawer')

  const statusLine = document.getElementById('status')
  const usageLine = document.getElementById('usage')
  const jumpLatest = document.getElementById('jump-latest')
  const questionCard = document.getElementById('question-card')
  const questionList = document.getElementById('question-list')
  const questionJump = document.getElementById('question-jump')
  const selectionChip = document.getElementById('selection-chip')
  const selectionChipText = document.getElementById('selection-chip-text')
  const selectionChipDismiss = document.getElementById('selection-chip-dismiss')

  let environment = {
    apiBase: location.origin.endsWith('/') ? location.origin.slice(0, -1) : location.origin,
    token: new URLSearchParams(location.search).get('token') ?? '',
    locale: 'zh',
    ballSize: 72,
  }

  let conversation = {
    sessionId: null,
    running: false,
    theme: 'light',
    model: null,
    usage: null,
    question: null,
    messages: [],
    history: [],
  }

  /**
   * Messages this panel has sent that have not reached the session log yet.
   *
   * A prompt sent while the agent is busy is queued by the host, and a queued prompt is not a durable
   * event: without this echo the user sees nothing at all until the running turn finishes.
   */
  let pendingSends = []

  let windowState = {
    ball: { x: 0, y: 0 },
    direction: { horizontal: 'right', vertical: 'down' },
    expanded: false,
    docked: null,
  }

  let expanded = false
  // 默认固定开启：给用户绝对掌控感，避免鼠标稍离开 180ms 就缩走消失
  let pinned = true
  let dragging = false
  let collapseTimer
  let collapseFrame
  /** Whether the pointer is currently over the expanded panel. */
  let pointerInsidePanel = false
  let eventSource
  let geometryKnown = false
  let shellFailure = null
  let rows = new Map()

  // ---------------------------------------------------------------- transport

  async function request(path, body, method) {
    const response = await fetch(`${environment.apiBase}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        'x-bubble-token': environment.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${path} -> ${response.status}`)
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text)
  }

  function subscribe() {
    eventSource?.close()
    const query = environment.token === '' ? '' : `?token=${encodeURIComponent(environment.token)}`
    eventSource = new EventSource(`${environment.apiBase}/events${query}`)
    eventSource.addEventListener('bubble', (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      applyEvent(payload)
    })
    eventSource.addEventListener('error', () => {
      /* EventSource auto-reconnects */
    })
  }

  function applyEvent(event) {
    switch (event.type) {
      case 'state':
        applyState(event.state)
        return
      case 'status':
        setRunning(event.running)
        return
      case 'append':
        appendMessage(event.message)
        return
      case 'delta':
        appendDelta(event.id, event.kind ?? 'text', event.text)
        return
      case 'update':
        updateMessage(event.message)
        return
      case 'replace':
        renderTranscript(event.messages)
        return
      case 'selection':
        showSelection(event.text)
        return
      case 'usage':
        applyUsage(event.usage)
        return
      case 'question':
        applyQuestion(event.question)
        return
      case 'reset':
        endStream()
        clearPending()
        applyQuestion(null)
        rows = new Map()
        transcript.replaceChildren()
        conversation.sessionId = event.sessionId
        conversation.messages = []
        conversation.running = false
        conversation.usage = null
        renderUsage()
        setRunning(false)
        renderEmpty()
        return
      default:
    }
  }

  function applyState(state) {
    if (state === undefined || state === null) return
    conversation.sessionId = state.sessionId ?? conversation.sessionId
    conversation.history = state.history ?? conversation.history
    conversation.model = state.model ?? null
    setTheme(state.theme ?? 'light')
    applyUsage(state.usage)
    applyQuestion(state.question ?? null)
    renderModelChip()
    setRunning(Boolean(state.running))
    if (Array.isArray(state.messages)) renderTranscript(state.messages)
  }

  function applyUsage(usage) {
    if (usage === undefined || usage === null) return
    conversation.usage = usage
    renderUsage()
  }

  /**
   * Render the agent's pending question.
   *
   * The ball cannot submit the answer: `ctx.userQuestions` allows exactly one provider and the DSH
   * window's client owns it, so hijacking it would break the main window. What the ball can do is
   * make the question impossible to miss and put the user in front of the surface that can answer.
   *
   * @param question - `{ callId, questions }` from the host, or null once it is resolved.
   */
  function applyQuestion(question) {
    conversation.question = question ?? null
    const items = conversation.question?.questions ?? []
    if (items.length === 0) {
      questionCard.hidden = true
      return
    }
    questionList.replaceChildren()
    for (const item of items) {
      const block = document.createElement('div')
      block.className = 'question-item'
      if (typeof item.header === 'string' && item.header !== '') {
        const header = document.createElement('p')
        header.className = 'question-header'
        header.textContent = item.header
        block.append(header)
      }
      const text = document.createElement('p')
      text.className = 'question-text'
      text.textContent = item.question
      block.append(text)
      if (Array.isArray(item.options) && item.options.length > 0) {
        const options = document.createElement('ul')
        options.className = 'question-options'
        for (const option of item.options) {
          const entry = document.createElement('li')
          entry.textContent = option.label
          if (typeof option.description === 'string' && option.description !== '') {
            entry.textContent = `${option.label} — ${option.description}`
          }
          options.append(entry)
        }
        block.append(options)
      }
      questionList.append(block)
    }
    questionCard.hidden = false
    statusLine.textContent = 'Agent 正在等你回答'
    void setExpanded(true)
    scrollToEnd(true)
    // Flash the taskbar so the prompt is noticed even when the panel is collapsed; unlike raising the
    // window this never steals focus from whatever the user is typing in.
    void shell('bubble_flash_main')
  }

  function formatTokens(value) {
    const count = Number(value ?? 0)
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
    return String(count)
  }

  function renderUsage() {
    const usage = conversation.usage
    if (usage === undefined || usage === null) {
      usageLine.textContent = ''
      return
    }
    const turn = usage.turn ?? {}
    const session = usage.session ?? {}
    if (turn.total === 0 && session.total === 0) {
      usageLine.textContent = ''
      return
    }
    const cache = (turn.cacheRead ?? 0) > 0 ? ` · ⚡${formatTokens(turn.cacheRead)}` : ''
    usageLine.textContent = `本轮 ↑${formatTokens(turn.input)} ↓${formatTokens(turn.output)}${cache}`
  }

  function modelLabel() {
    const selected = conversation.model
    if (selected === null || selected === undefined) return '选择模型'
    const name = selected.model.split('/').pop()
    const effort = selected.reasoningEffort ? ` (${selected.reasoningEffort})` : ''
    return `${name}${effort}`
  }

  function renderModelChip() {
    modelNameText.textContent = modelLabel()
  }

  // ------------------------------------------------------------------ window geometry

  async function shell(command, args) {
    if (!inDesktop) return undefined
    try {
      return await invoke(command, args)
    } catch (error) {
      shellFailure = `${command}: ${String(error)}`
      console.warn(`bubble: ${command} failed`, error)
      return undefined
    }
  }

  async function readGeometry() {
    const reported = await shell('bubble_state')
    if (reported !== undefined && reported !== null) return reported
    const window_ = tauri?.window?.getCurrentWindow?.()
    if (window_ === undefined) return undefined
    try {
      const [position, scale] = await Promise.all([window_.outerPosition(), window_.scaleFactor()])
      const isLeft = document.body.classList.contains('expand-left')
      const isUp = document.body.classList.contains('expand-up')
      let x = Math.round(position.x / scale) + 12
      let y = Math.round(position.y / scale) + 12
      if (expanded) {
        if (isLeft) x = Math.round(position.x / scale) + 344 - 12 - 72
        if (isUp) y = Math.round(position.y / scale) + 444 - 12 - 72
      }
      return {
        ball: { x, y },
        direction: { ...windowState.direction },
        expanded,
        docked: null,
      }
    } catch (error) {
      shellFailure = `outerPosition: ${String(error)}`
      return undefined
    }
  }

  function applyWindowState(next) {
    if (next === undefined || next === null) return
    windowState = next
    document.body.classList.toggle('expand-left', next.direction.horizontal === 'left')
    document.body.classList.toggle('expand-right', next.direction.horizontal === 'right')
    document.body.classList.toggle('expand-up', next.direction.vertical === 'up')
    document.body.classList.toggle('expand-down', next.direction.vertical === 'down')
    geometryKnown = true
    persistGeometry()
  }

  let persistTimer
  function persistGeometry() {
    if (!geometryKnown) return
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      void request('/geometry', {
        ball: windowState.ball,
        direction: windowState.direction,
        docked: null,
        ...(shellFailure === null ? {} : { shellFailure }),
      }).catch(() => {})
    }, 500)
  }

  /**
   * Apply new window geometry with the ball and panel hidden.
   *
   * The ball's resting place is the window's top-left corner and the docked corner only follows the
   * `body.expand-*` classes, which the shell's snapshot supplies. The window therefore resizes before
   * those classes change, and without this lock the frames in between show a big window with the ball
   * still in the top-left corner: the flash users see on every expand. The window background is fully
   * transparent, so hiding for those frames is invisible, while any misplaced frame is not.
   *
   * @param expanded - Target state to ask the shell for.
   * @returns The shell's geometry snapshot, or undefined when the shell did not answer.
   */
  /**
   * Run a window-geometry change with the ball and panel hidden, revealing only at the very end.
   *
   * The ball's resting place is the window's top-left corner and the docked corner only follows the
   * `body.expand-*` classes. Resizing the window and applying those classes are therefore two separate
   * moments, and every frame between them shows the ball in the wrong corner: that is the flash users
   * see on expand. The lock covers both, and `nextPaintedFrame` guarantees the hidden state is actually
   * on screen before the window changes size — measured on the live shell, a lock that skipped that wait
   * lived 10 ms against a 16.7 ms frame and the flash survived.
   *
   * @param work - Geometry change plus the state application that must stay hidden.
   * @returns Whatever `work` returns.
   */
  async function withLayoutLock(work) {
    document.body.classList.add('layout-change')
    // Force a style flush so the hiding style exists in this task.
    void document.body.offsetHeight
    void shell('bubble_panel_log', { message: 'lock on' })
    await nextPaintedFrame()
    try {
      return await work()
    } finally {
      document.body.classList.remove('layout-change')
      void shell('bubble_panel_log', { message: 'lock off' })
    }
  }

  async function setExpanded(next, force = false) {
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      await withLayoutLock(async () => {
        applyWindowState(await shell('bubble_set_expanded', { expanded: true }))
        panel.hidden = false
        expanded = true
        document.body.classList.add('expanded')
        stop.hidden = !conversation.running
      })
      scrollToEnd()
      return
    }
    // 未强制且满足保护条件时不缩起
    if (!force && holdsPanel()) return
    expanded = false
    document.body.classList.remove('expanded')
    closeDrawers()
    stop.hidden = true
    if (force) {
      panel.hidden = true
      await withLayoutLock(async () => {
        applyWindowState(await shell('bubble_set_expanded', { expanded: false }))
      })
      return
    }
    collapseFrame = setTimeout(async () => {
      collapseFrame = undefined
      panel.hidden = true
      // The class flip above already ran the exit animation; the window shrink happens now, so the
      // ball keeps its docked corner until the geometry is final.
      await withLayoutLock(async () => {
        applyWindowState(await shell('bubble_set_expanded', { expanded: false }))
      })
    }, ANIMATION_MS)
  }

  /**
   * Whether something still justifies keeping the panel open when the pointer wanders.
   *
   * Focus counts: typing into the composer moves the pointer out of the panel (or the panel grows
   * away from the cursor), and auto-collapsing mid-sentence is never what the user meant. The
   * pointer being inside the panel counts for the same reason - hover expanded it, so hover holds it.
   *
   * @returns True when the panel must stay expanded.
   */
  function holdsPanel() {
    return pinned
      || conversation.running
      || dragging
      || hasSelectionChip()
      || isDrawerOpen()
      || pointerInsidePanel
      || hasPanelFocus()
  }

  /**
   * Whether keyboard focus currently lives inside the panel *and the window still has it*.
   *
   * `document.activeElement` does not change when the window loses OS focus: switching to another app
   * leaves the composer as the active element even though the caret has visibly gone. Trusting it
   * alone meant the panel never collapsed again after typing once, so the window's own focus state
   * decides first.
   *
   * @returns True when the user is really typing in the panel.
   */
  function hasPanelFocus() {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
    const active = document.activeElement
    return active !== null && active !== document.body && panel.contains(active)
  }

  /** Drop a pending auto-collapse. */
  function cancelCollapse() {
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
  }

  function scheduleCollapse() {
    if (holdsPanel()) return
    cancelCollapse()
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_DELAY_MS)
  }

  // -------------------------------------------------------------------- drag

  function pointerScreen(event) {
    return { x: event.screenX, y: event.screenY }
  }

  function ballOriginFromPointer(start, event) {
    const now = pointerScreen(event)
    return {
      x: Math.round(start.ball.x + (now.x - start.screen.x)),
      y: Math.round(start.ball.y + (now.y - start.screen.y)),
    }
  }

  function onBallPointerDown(event) {
    if (event.button !== 0) return
    const start = {
      screen: pointerScreen(event),
      ball: { ...windowState.ball },
      moved: false,
    }
    dragging = false
    ball.setPointerCapture(event.pointerId)

    const onMove = (moveEvent) => {
      const now = pointerScreen(moveEvent)
      if (Math.abs(now.x - start.screen.x) < DRAG_THRESHOLD && Math.abs(now.y - start.screen.y) < DRAG_THRESHOLD) return
      if (!start.moved) {
        start.moved = true
        dragging = true
        void setExpanded(false, true)
      }
      const origin = ballOriginFromPointer(start, moveEvent)
      void shell('bubble_move_ball', {
        x: origin.x,
        y: origin.y,
        canDock: false, // 禁用消失成细线的反人类 dock
      }).then(applyWindowState)
    }

    const onUp = (upEvent) => {
      ball.releasePointerCapture(upEvent.pointerId)
      ball.removeEventListener('pointermove', onMove)
      ball.removeEventListener('pointerup', onUp)
      ball.removeEventListener('pointercancel', onUp)
      if (start.moved) {
        dragging = false
        void shell('bubble_clamp', { canDock: false }).then(applyWindowState)
        return
      }
      // 单击球本体：切换展开/收起
      if (expanded) {
        void setExpanded(false, true)
      } else {
        void setExpanded(true)
        focusComposer()
      }
    }

    ball.addEventListener('pointermove', onMove)
    ball.addEventListener('pointerup', onUp)
    ball.addEventListener('pointercancel', onUp)
    event.preventDefault()
  }

  // ------------------------------------------------------------------- theme

  function setTheme(theme) {
    conversation.theme = theme
    if (theme === 'dark') document.documentElement.dataset.dsDarkTheme = ''
    else delete document.documentElement.dataset.dsDarkTheme
  }

  // -------------------------------------------------------------- transcript

  /** TeX renderer backed by the vendored KaTeX, or the plain fallback when it is unavailable. */
  function renderMath(tex, display) {
    const katex = window.katex
    if (katex === undefined) return null
    return katex.renderToString(tex, {
      displayMode: Boolean(display),
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      trust: false,
    })
  }

  /** Markdown source to HTML, with math handed to KaTeX. */
  function renderMarkdown(text) {
    const renderer = window.BubbleMarkdown
    if (renderer === undefined) return escapeHtml(text).replace(/\n/gu, '<br>')
    return renderer.render(text, { math: renderMath })
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
  }

  /**
   * Attach behaviour the HTML string cannot carry: code copy buttons and link routing.
   *
   * @param root - Freshly rendered element.
   */
  function enhance(root) {
    for (const button of root.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const code = button.parentElement?.querySelector('code')
        if (code === null || code === undefined) return
        void navigator.clipboard?.writeText(code.textContent ?? '').then(() => {
          button.textContent = '已复制'
          setTimeout(() => { button.textContent = '复制' }, 1200)
        })
      })
    }
    for (const anchor of root.querySelectorAll('a[href]')) {
      anchor.addEventListener('click', (event) => {
        event.preventDefault()
        const href = anchor.getAttribute('href') ?? ''
        void shell('bubble_open_url', { url: href })
      })
    }
  }

  function renderEmpty() {
    if (conversation.messages.length > 0) return
    const empty = document.createElement('div')
    empty.className = 'transcript-empty'
    empty.innerHTML = '<span>桌面 AI 伴侣就绪</span><span style="font-size:11px;opacity:0.7">直接打字发送，或在任意屏幕选中文本划词</span>'
    transcript.append(empty)
  }

  function createRow(message) {
    const row = document.createElement('div')
    row.className = `row row-${message.role}`
    row.dataset.id = message.id
    if (message.role === 'tool') {
      const head = document.createElement('div')
      head.className = 'tool-head'
      const name = document.createElement('span')
      name.className = 'tool-name'
      name.textContent = message.name ?? 'tool'
      const summary = document.createElement('span')
      summary.className = 'tool-summary'
      summary.textContent = message.summary ?? ''
      head.append(name, summary)
      const body = document.createElement('pre')
      body.className = 'tool-body'
      body.textContent = message.detail ?? ''
      head.addEventListener('click', () => row.classList.toggle('open'))
      row.append(head, body)
      return row
    }
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (message.role === 'assistant') {
      bubble.innerHTML = renderMarkdown(message.text ?? '')
      enhance(bubble)
    } else {
      bubble.textContent = message.text ?? ''
    }
    row.append(bubble)
    return row
  }

  /** The live assistant bubble, which survives transcript rebuilds for the whole run. */
  let stream = { active: false, text: '', reasoning: '', settled: false, row: null, bubble: null, frame: undefined, settleTimer: undefined }

  function updateStreamRow() {
    if (!stream.active) return
    if (stream.row === null || !stream.row.isConnected) {
      stream.row = document.createElement('div')
      stream.row.className = 'row row-assistant'
      stream.row.dataset.id = STREAM_ID
      stream.bubble = document.createElement('div')
      stream.bubble.className = 'bubble'
      stream.row.append(stream.bubble)
      transcript.querySelector('.transcript-empty')?.remove()
      transcript.append(stream.row)
    }
    if (stream.bubble === null) return
    const thinking = stream.reasoning === '' || stream.text !== ''
      ? ''
      : `<details class="thinking" open><summary>思考中…</summary><div class="thinking-body">${escapeHtml(stream.reasoning)}</div></details>`
    stream.bubble.innerHTML = `${thinking}${renderMarkdown(stream.text)}`
    enhance(stream.bubble)
    stream.bubble.classList.toggle('cursor', conversation.running && stream.text === '')
    scrollToEnd()
  }

  /**
   * Resolve once the current DOM state has been painted.
   *
   * A `requestAnimationFrame` callback runs *before* its frame is painted, and an `await` continuation
   * after it is a microtask that also runs before that paint. A `setTimeout` task scheduled from inside
   * the frame callback runs after the frame is painted, so the sequence here is "one frame, then a task":
   * by the time it resolves, the hidden state is on screen. Two animation frames were tried first and
   * measured insufficient for exactly that microtask reason.
   *
   * A safety timeout keeps this from blocking forever when the webview throttles frames (hidden or
   * minimized), where nothing is being painted for the user to see anyway.
   *
   * @returns A promise that settles after the next painted frame, or after 120 ms.
   */
  function nextPaintedFrame() {
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      nextPaint(() => {
        setTimeout(done, 0)
      })
      setTimeout(done, 120)
    })
  }

  /**
   * Run a callback after the next paint, but never later than a short timeout.
   *
   * Chromium throttles `requestAnimationFrame` in an occluded, collapsed, or minimized webview, and the
   * ball is collapsed most of the time: without the timeout a streamed answer would sit unseen until
   * the user reopened the panel. Whichever fires first wins; the other is cancelled.
   *
   * @param callback - Work to run once.
   * @returns Handle accepted by {@link cancelPaint}.
   */
  function nextPaint(callback) {
    const handle = { frame: undefined, timer: undefined, done: false }
    const run = () => {
      if (handle.done) return
      handle.done = true
      cancelPaint(handle)
      callback()
    }
    handle.frame = requestAnimationFrame(run)
    handle.timer = setTimeout(run, 48)
    return handle
  }

  /**
   * Cancel a pending {@link nextPaint}.
   * @param handle - Handle returned by `nextPaint`.
   */
  function cancelPaint(handle) {
    if (handle === undefined) return
    if (handle.frame !== undefined) cancelAnimationFrame(handle.frame)
    if (handle.timer !== undefined) clearTimeout(handle.timer)
    handle.frame = undefined
    handle.timer = undefined
  }

  /** Coalesce token bursts into one DOM update per frame. */
  function scheduleStreamRender() {
    if (stream.frame !== undefined) return
    stream.frame = nextPaint(() => {
      stream.frame = undefined
      updateStreamRow()
    })
  }

  function beginStream() {
    stream.active = true
    stream.text = ''
    stream.reasoning = ''
    stream.settled = false
    stream.row = null
    stream.bubble = null
  }

  function endStream() {
    stream.active = false
    stream.text = ''
    stream.reasoning = ''
    stream.settled = false
    if (stream.frame !== undefined) {
      cancelAnimationFrame(stream.frame)
      stream.frame = undefined
    }
    if (stream.settleTimer !== undefined) {
      clearTimeout(stream.settleTimer)
      stream.settleTimer = undefined
    }
    stream.row?.remove()
    stream.row = null
    stream.bubble = null
  }

  /**
   * The run finished. Keep the live bubble until the transcript arrives with the committed message,
   * so the answer never blinks out; a short timer covers a transcript that never comes.
   */
  function settleStream() {
    if (!stream.active) return
    stream.settled = true
    stream.bubble?.classList.remove('cursor')
    if (stream.settleTimer !== undefined) clearTimeout(stream.settleTimer)
    stream.settleTimer = setTimeout(() => {
      stream.settleTimer = undefined
      endStream()
    }, 3000)
  }

  function renderTranscript(messages) {
    // A rebuilt transcript that carries a new tail is a new message for the reader: follow it even if
    // they had scrolled back. A rebuild that only updates existing rows must not move the viewport.
    const previousTail = conversation.messages.at(-1)?.id
    const tailChanged = messages.at(-1)?.id !== previousTail || messages.length > conversation.messages.length
    conversation.messages = messages
    rows = new Map()
    transcript.replaceChildren()
    // A durable transcript that carries the answer retires the live bubble; otherwise it comes back.
    if (stream.settled) endStream()
    if (messages.length === 0 && !stream.active) {
      renderEmpty()
      return
    }
    for (const message of messages) {
      const row = createRow(message)
      rows.set(message.id, row)
      transcript.append(row)
    }
    // A durable event rebuilds the transcript mid-answer; the live bubble must come back with it.
    if (stream.active && stream.text !== '') {
      stream.row = null
      stream.bubble = null
      updateStreamRow()
      scrollToEnd(tailChanged)
    } else {
      scrollToEnd(true)
    }
    settlePending(messages)
    renderPending()
  }

  function appendMessage(message) {
    transcript.querySelector('.transcript-empty')?.remove()
    conversation.messages.push(message)
    const row = createRow(message)
    rows.set(message.id, row)
    if (stream.row !== null && stream.row.isConnected) transcript.insertBefore(row, stream.row)
    else transcript.append(row)
    // A new message is the user's reason to look at the panel: always follow it.
    scrollToEnd(true)
    settlePending(conversation.messages)
  }

  function updateMessage(message) {
    conversation.messages = conversation.messages.map((item) => (item.id === message.id ? message : item))
    const row = rows.get(message.id)
    if (row === undefined) {
      appendMessage(message)
      return
    }
    const next = createRow(message)
    row.replaceWith(next)
    rows.set(message.id, next)
    scrollToEnd()
    settlePending(conversation.messages)
  }

  function appendDelta(id, kind, text) {
    if (id !== STREAM_ID) return
    if (!stream.active) beginStream()
    if (kind === 'reasoning') stream.reasoning += text
    else stream.text += text
    conversation.running = true
    scheduleStreamRender()
  }

  /** True when the reader is close enough to the tail to be following it. */
  function atTail() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 48
  }

  /**
   * Follow the transcript tail.
   *
   * @param force - When true, jump to the newest content even if the reader scrolled away. Used for
   *   new messages, prompts this panel sent, and an arriving question; streaming deltas keep the
   *   gentler follow so reading back through a long answer is not yanked away.
   */
  function scrollToEnd(force = false) {
    if (!force && !atTail()) {
      jumpLatest.hidden = false
      return
    }
    transcript.scrollTop = transcript.scrollHeight
    jumpLatest.hidden = true
    // Images and math load after the height is computed; re-pin once more after layout settles.
    nextPaint(() => {
      if (force || atTail()) {
        transcript.scrollTop = transcript.scrollHeight
        jumpLatest.hidden = true
      }
    })
  }

  /** Echo prompts that the host has accepted but that are not in the session log yet. */
  function renderPending() {
    for (const entry of pendingSends) {
      if (entry.row !== undefined && entry.row.isConnected) continue
      const row = document.createElement('div')
      row.className = 'row row-user row-pending'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.textContent = entry.text
      const tag = document.createElement('span')
      tag.className = 'pending-tag'
      tag.textContent = '已发出，等待 Agent 处理…'
      bubble.append(tag)
      row.append(bubble)
      entry.row = row
      transcript.append(row)
    }
  }

  /**
   * Retire queued echoes once the durable transcript carries them.
   *
   * Matching on text is enough here: a queued prompt becomes a `user/message` event with the same
   * text, and two identical prompts in a row still both reach the log.
   *
   * @param messages - The durable transcript.
   */
  function settlePending(messages) {
    if (pendingSends.length === 0) return
    const texts = messages.filter((message) => message.role === 'user').map((message) => message.text)
    const kept = []
    for (const entry of pendingSends) {
      if (texts.includes(entry.text)) {
        entry.row?.remove()
        continue
      }
      kept.push(entry)
    }
    pendingSends = kept
  }

  function clearPending() {
    for (const entry of pendingSends) entry.row?.remove()
    pendingSends = []
  }

  function setRunning(running) {
    const wasRunning = conversation.running
    conversation.running = running
    document.body.classList.toggle('running', running)
    stop.hidden = !running
    statusLine.textContent = running ? 'Agent 正在思考响应…' : ''
    if (running && !wasRunning && !stream.active) beginStream()
    if (!running) settleStream()
    if (running) void setExpanded(true)
  }

  function hasSelectionChip() {
    return !selectionChip.hidden
  }

  function showSelection(text) {
    selectionChipText.textContent = text
    selectionChip.hidden = false
    document.body.classList.add('has-selection-chip')
    void setExpanded(true)
    focusComposer()
  }

  function clearSelection() {
    selectionChip.hidden = true
    document.body.classList.remove('has-selection-chip')
  }

  // ---------------------------------------------------------------- Drawers (抽屉与浮层)

  function isDrawerOpen() {
    return !modelDrawer.hidden || !historyDrawer.hidden
  }

  function closeDrawers() {
    modelDrawer.hidden = true
    historyDrawer.hidden = true
    modelButton.setAttribute('aria-expanded', 'false')
    historyButton.setAttribute('aria-pressed', 'false')
  }

  function wireDrawers() {
    // 关闭抽屉按钮
    closeModelDrawerBtn.addEventListener('click', closeDrawers)
    closeHistoryDrawerBtn.addEventListener('click', closeDrawers)

    // 点击对白区收起抽屉
    transcript.addEventListener('pointerdown', () => {
      if (isDrawerOpen()) closeDrawers()
    })

    // ESC 键优雅退场
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (isDrawerOpen()) {
          closeDrawers()
        } else if (!pinned) {
          void setExpanded(false, true)
        }
      }
    })
  }

  // ---------------------------------------------------------------- Model Picker

  async function chooseModel(choice) {
    try {
      const selected = await request('/model', choice)
      conversation.model = selected
      renderModelChip()
      closeDrawers()
    } catch (error) {
      statusLine.textContent = `切换模型失败：${String(error)}`
    }
  }

  function renderModelRow(group, model, selected) {
    const isCurrent = selected !== null && selected?.provider === group.id && selected?.model === model.id
    const row = document.createElement('div')
    row.className = `model-row${isCurrent ? ' current' : ''}`

    const nameTitle = document.createElement('span')
    nameTitle.className = 'model-name-title'
    nameTitle.textContent = model.name ?? model.id
    row.append(nameTitle)

    if (model.description) {
      const note = document.createElement('span')
      note.className = 'model-note'
      note.textContent = model.description
      row.append(note)
    }

    nameTitle.addEventListener('click', () => {
      void chooseModel({
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
      })
    })

    // 推理强度标签
    if (model.reasoning?.efforts && model.reasoning.efforts.length > 0) {
      const effortRow = document.createElement('div')
      effortRow.className = 'effort-row'
      const title = document.createElement('span')
      title.className = 'effort-title'
      title.textContent = '思考强度:'
      effortRow.append(title)

      for (const effort of model.reasoning.efforts) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `effort-btn${isCurrent && selected?.reasoningEffort === effort.id ? ' current' : ''}`
        btn.textContent = effort.name ?? effort.id
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          void chooseModel({ provider: group.id, model: model.id, reasoningEffort: effort.id })
        })
        effortRow.append(btn)
      }
      row.append(effortRow)
    }

    modelList.append(row)
  }

  function wireModel() {
    modelButton.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = modelDrawer.hidden
      closeDrawers()
      if (willOpen) {
        modelDrawer.hidden = false
        modelButton.setAttribute('aria-expanded', 'true')
        modelList.replaceChildren()
        
        const loading = document.createElement('div')
        loading.className = 'history-empty'
        loading.textContent = '加载可用模型列表中…'
        modelList.append(loading)

        void request('/models').then((catalog) => {
          modelList.replaceChildren()
          const selected = catalog.selected ?? null
          if (!Array.isArray(catalog.groups) || catalog.groups.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'history-empty'
            empty.textContent = '未发现已配置的在线模型'
            modelList.append(empty)
            return
          }
          for (const group of catalog.groups) {
            const heading = document.createElement('div')
            heading.className = 'model-group'
            heading.textContent = group.name ?? group.id
            modelList.append(heading)
            for (const model of group.models ?? []) {
              renderModelRow(group, model, selected)
            }
          }
        }).catch((error) => {
          modelList.replaceChildren()
          const err = document.createElement('div')
          err.className = 'history-empty'
          err.style.color = 'var(--error)'
          err.textContent = `加载失败: ${String(error?.message ?? error)}`
          modelList.append(err)
        })
      }
    })
  }

  // ---------------------------------------------------------------- History

  function wireHistory() {
    historyButton.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = historyDrawer.hidden
      closeDrawers()
      if (willOpen) {
        historyDrawer.hidden = false
        historyButton.setAttribute('aria-pressed', 'true')
        historyList.replaceChildren()

        const loading = document.createElement('div')
        loading.className = 'history-empty'
        loading.textContent = '正在获取历史会话…'
        historyList.append(loading)

        void request('/history').then((history) => {
          historyList.replaceChildren()
          if (!Array.isArray(history) || history.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'history-empty'
            empty.textContent = '暂无历史会话'
            historyList.append(empty)
            return
          }
          for (const entry of history) {
            const row = document.createElement('div')
            row.className = `history-row${entry.id === conversation.sessionId ? ' current' : ''}`
            const title = document.createElement('span')
            title.className = 'history-title'
            title.textContent = entry.title || '新会话'
            row.append(title)

            row.addEventListener('click', () => {
              closeDrawers()
              void request('/select', { sessionId: entry.id })
            })
            historyList.append(row)
          }
        }).catch((err) => {
          historyList.replaceChildren()
          const errDiv = document.createElement('div')
          errDiv.className = 'history-empty'
          errDiv.style.color = 'var(--error)'
          errDiv.textContent = `读取失败: ${String(err?.message ?? err)}`
          historyList.append(errDiv)
        })
      }
    })

    newButton.addEventListener('click', () => {
      closeDrawers()
      void request('/new', {})
    })
  }

  // ---------------------------------------------------------------- input

  /**
   * The composer's current text.
   *
   * `innerText` mirrors the visual line breaks of the contenteditable, but it is layout-dependent: while
   * the panel is hidden — the frames covering a window geometry change — it can read as empty, which
   * would silently drop what the user typed. Fall back to `textContent` when the rendered text is empty
   * but the source is not.
   *
   * @returns The prompt text without the trailing newline a contenteditable leaves behind.
   */
  function promptText() {
    const rendered = prompt.innerText
    const source = prompt.textContent ?? ''
    return (rendered === '' ? source : rendered).replace(/\n$/u, '')
  }

  function syncPromptState() {
    prompt.classList.toggle('prompt-empty', promptText().trim() === '')
  }

  function focusComposer() {
    setTimeout(() => {
      prompt.focus()
    }, 60)
  }

  async function send() {
    const text = promptText().trim()
    if (text === '') return
    const chip = hasSelectionChip() ? selectionChipText.textContent : ''
    const payload = chip === '' ? text : `【引用的选中文本】\n${chip}\n\n${text}`
    prompt.textContent = ''
    syncPromptState()
    clearSelection()
    try {
      await request('/message', { text: payload })
      // The host accepts prompts while the agent is running by queueing them, and a queued prompt is
      // not a durable event. Echo it locally so the user can see what they sent.
      pendingSends.push({ text: payload })
      renderPending()
      scrollToEnd(true)
      if (conversation.running) statusLine.textContent = '已排队，等当前回答结束'
    } catch (error) {
      statusLine.textContent = `发送失败：${String(error)}`
    }
  }

  function wireComposer() {
    prompt.addEventListener('input', syncPromptState)
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    })
    composer.addEventListener('submit', (event) => {
      event.preventDefault()
      void send()
    })
  }

  // ---------------------------------------------------------------- Pin & Close

  function wireWindowControls() {
    jumpLatest.addEventListener('click', () => {
      scrollToEnd(true)
      prompt.focus()
    })
    transcript.addEventListener('scroll', () => {
      if (atTail()) jumpLatest.hidden = true
      else if (conversation.messages.length > 0 || pendingSends.length > 0) jumpLatest.hidden = false
    })
    questionJump.addEventListener('click', async () => {
      const label = questionJump.textContent
      questionJump.disabled = true
      shellFailure = ''
      const result = await shell('bubble_focus_main')
      questionJump.disabled = false
      if (result === undefined && shellFailure !== '') {
        // Never leave a silent no-op: report what failed instead.
        questionJump.textContent = '激活失败，请手动切到 DSH 窗口'
        statusLine.textContent = `无法激活 DSH 主窗口：${shellFailure}`
        setTimeout(() => {
          questionJump.textContent = label
        }, 3000)
        return
      }
      statusLine.textContent = '已切到 DSH 主窗口，请在那里回答'
    })

    // 固定状态切换
    document.body.classList.toggle('pinned', pinned)
    pinButton.addEventListener('click', () => {
      pinned = !pinned
      document.body.classList.toggle('pinned', pinned)
      pinButton.title = pinned ? '已固定 (点击取消固定)' : '未固定 (点击固定)'
    })

    // 关闭/收起面板按钮
    closePanelButton.addEventListener('click', () => {
      void setExpanded(false, true)
    })
  }

  // ------------------------------------------------------------------ boot

  async function loadEnvironment() {
    if (inDesktop) {
      // Record which panel build this shell is running; the executable embeds the panel, so this is
      // the only way to tell a current ball from one carrying a stale UI.
      void shell('bubble_panel_ready', { revision: PANEL_REVISION })
      const env = await shell('bubble_environment')
      if (env !== undefined && env !== null) {
        environment = {
          apiBase: env.api_base,
          token: env.token,
          locale: env.locale,
          ballSize: env.ball_size,
        }
        document.documentElement.lang = env.locale === 'en' ? 'en' : 'zh'
      }
      const geometry = await readGeometry()
      if (geometry !== undefined && geometry !== null) applyWindowState(geometry)
      if (typeof listen === 'function') {
        await listen('bubble:geometry', (event) => applyWindowState(event.payload))
      }
    }
  }

  async function boot() {
    wireWindowControls()
    wireComposer()
    wireHistory()
    wireModel()
    wireDrawers()
    renderModelChip()
    renderUsage()
    
    ball.addEventListener('pointerdown', onBallPointerDown)
    stop.addEventListener('click', () => {
      void request('/cancel', {})
    })

    selectionChipDismiss.addEventListener('click', clearSelection)

    // 指针离开窗口 / 面板时柔和自动收起，但焦点或指针还在面板里就不收（见 holdsPanel）。
    document.addEventListener('pointerleave', scheduleCollapse)
    panel.addEventListener('pointerenter', () => {
      pointerInsidePanel = true
      cancelCollapse()
    })
    panel.addEventListener('pointerleave', () => {
      pointerInsidePanel = false
      scheduleCollapse()
    })
    // 输入框（或面板内任何控件）拿到焦点就不再自动收起；失焦后再重新评估。
    panel.addEventListener('focusin', cancelCollapse)
    panel.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!hasPanelFocus()) scheduleCollapse()
      }, 0)
    })
    // 窗口失去焦点（切到别的应用）时 hasPanelFocus() 立刻失效，收起计时随即开始；
    // 回到窗口则撤销待处理的收起。
    window.addEventListener('blur', () => {
      if (!hasPanelFocus()) scheduleCollapse()
    })
    window.addEventListener('focus', cancelCollapse)

    await loadEnvironment()
    applyWindowState(windowState)
    // The window has its final geometry and docking corner now, so the first visible frame is correct.
    // The timeout is a safety net: a shell that never answers must not leave the ball invisible.
    document.body.classList.remove('layout-change')
    setTimeout(() => document.body.classList.remove('layout-change'), 800)

    try {
      const state = await request('/state')
      applyState(state)
    } catch (error) {
      statusLine.textContent = `未连接到 DSH：${String(error)}`
    }
    subscribe()
    syncPromptState()
  }

  void boot()
})()
