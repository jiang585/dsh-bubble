/**
 * The `code_agent` tool: hand one stretch of background work to a first-class standard session.
 *
 * The tool is registered as a raw `ToolDefinition` rather than through `defineTool`, because this
 * plugin must load without importing any `@deepseek-ai/*` package: a relative-path plugin entry is
 * resolved by Node's own ESM resolver, which cannot see the harness's node_modules. Arguments are
 * therefore declared as plain JSON Schema and validated here.
 *
 * @module dsh-bubble/src/host/code-agent
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Model-visible tool name. */
export const CODE_AGENT_TOOL = 'code_agent'

/** Model-visible description; the model routes work to the background track from this text alone. */
const DESCRIPTION = [
  'Hand one self-contained piece of work to a background standard session and return immediately.',
  'Use it for work that takes a while and does not need the ball: reading many files, producing a',
  'document, or building a site. Omit session_id to start a new background session; pass the id this',
  'tool returned earlier to continue the same artifact instead of starting a second one.',
  'The background session cannot see the screen. When the user asked for a file, produce the file',
  'and answer with its path; otherwise answer in a few sentences and stop.',
].join(' ')

/** Longest task text accepted from the model. */
const TASK_LIMIT = 8000

/** Bounded completion notice body, matching the original ball's notice cap. */
const NOTICE_LIMIT = 4000

/** Standard preset that background sessions run under. */
const BACKGROUND_PRESET = 'standard'

/**
 * Queue one task on a background standard session.
 * @param ctx - Host context; `sessionController` must be injected.
 * @param conversation - The ball's conversation, used for the workspace directory.
 * @param args - Validated tool arguments.
 * @returns Canonical tool value.
 */
async function dispatch(ctx, conversation, args) {
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task === '') throw new Error('code_agent 需要一个非空的 task')
  if (task.length > TASK_LIMIT) throw new Error(`code_agent 的 task 不能超过 ${TASK_LIMIT} 个字符`)

  let created = false
  let sessionId = typeof args.session_id === 'string' && args.session_id !== '' ? args.session_id : undefined
  let cwd = conversation.directory()

  if (sessionId === undefined) {
    cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : await mintDirectory(conversation.directory(), task)
    const session = await ctx.sessionController.create({ agentPreset: BACKGROUND_PRESET, cwd })
    sessionId = session.sessionId
    created = true
  }

  await ctx.sessionController.prompt(
    {
      requestId: `bubble-code-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task }],
    },
    new AbortController().signal,
  )
  return { accepted: true, created, session_id: String(sessionId) }
}

/**
 * Create a unique subdirectory under the bubble workspace for one background task.
 * @param root - Bubble workspace directory.
 * @param task - Task text, used for a readable slug.
 * @returns Absolute directory path.
 */
async function mintDirectory(root, task) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
  const directory = join(root, slug === '' ? `task-${randomUUID().slice(0, 8)}` : `${slug}-${randomUUID().slice(0, 6)}`)
  await mkdir(directory, { recursive: true })
  return directory
}

/** Last assistant text of a background session, used for the completion notice. */
function lastAssistantText(agent) {
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = (message.content ?? [])
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Watch one dispatched background session and hand its result back to the ball.
 *
 * The notice reaches the ball's own UI directly. It is not injected back into the front session:
 * a follow-up user message would have to be minted as a full `UserMessage`, and this plugin must
 * not import `@deepseek-ai/dsh-llm` to build one.
 *
 * @param options - Caller session id, background session id, task text, and the ball's publisher.
 */
function watchCompletion({ ctx, callerId, sessionId, task, conversation, logger }) {
  const agents = ctx.get('agents')
  if (agents === undefined) return
  const background = agents.get(sessionId)
  if (background === undefined) return
  void (async () => {
    try {
      await background.whenIdle()
      const outcome = lastAssistantText(background) ?? '后台会话结束，但没有留下最终回复。'
      const body = `后台任务已完成：\n${task}\n\n${outcome}`
      conversation.notify({
        text: body.length <= NOTICE_LIMIT ? body : `${body.slice(0, NOTICE_LIMIT - 1)}…`,
        sessionId: String(sessionId),
        callerId: String(callerId),
      })
    } catch (error) {
      logger.warn('dsh-bubble: background completion watch failed', error)
    }
  })()
}

/**
 * Register the `code_agent` tool on the host tool registry.
 * @param ctx - Host context; `tools` must be injected.
 * @param conversation - The ball's conversation.
 * @param logger - Warning sink.
 * @returns Tool disposer.
 */
export function registerCodeAgent(ctx, conversation, logger) {
  return ctx.tools.register({
    name: CODE_AGENT_TOOL,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: 'The user message to enqueue for the background session. Required.',
        },
        session_id: {
          type: 'string',
          description: 'Existing standard session to continue. Omit to start a new background session.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for a new background session. Omit for a fresh subdirectory of the ball workspace.',
        },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          created: { type: 'boolean' },
          session_id: { type: 'string' },
        },
        required: ['accepted', 'created', 'session_id'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.created === true
            ? `已派发后台会话 ${value.session_id}，它会在后台跑完并把结果带回悬浮球。要继续同一份产物就把这个 id 传回来。`
            : `已把这段任务追加到后台会话 ${value.session_id}。`,
        },
      ],
      presentationMeta: (_args, value) => ({ sessionId: value.session_id, created: value.created }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const callerId = exec.agent === undefined ? '' : String(exec.agent.id)
      const result = await dispatch(ctx, conversation, args)
      if (result.created) {
        watchCompletion({
          ctx,
          callerId,
          sessionId: result.session_id,
          task: typeof args.task === 'string' ? args.task : '',
          conversation,
          logger,
        })
      }
      return result
    },
  })
}
