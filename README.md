# dsh-bubble

**The floating ball from DeepSeek Orb, repackaged as a DeepSeek Harness plugin — no second dsh install.**

English | [中文](README.zh.md)

A ball rests at the edge of your screen. Hover to open a panel and talk to your agent; select text in any
application to get a 搜索 / 翻译 / 发给 Agent toolbar; hand long jobs to a background code session and the
result comes back to the ball. It mounts onto the **DeepSeek Harness Desktop you already have** — it does not
bundle dsh, does not start its own host, and does not ship Electron.

> This is a **derivative work** of [DeepSeek Orb](https://github.com/mini-yifan/deepseek-harness-orb): only its
> floating ball, converted from an Electron application into a DSH plugin. Upstream itself is built on
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh 0.1.7).
> Not affiliated with DeepSeek AI.

## What it is

| | |
|---|---|
| Shape | A DSH plugin (loaded by relative path, zero runtime dependencies) hosted by DSH Desktop |
| Desktop shell | Tauri 2 + Rust native windows (`dsh-bubble-shell.exe`, ~12 MB) |
| Platform | Windows only |
| On the ball | Chat (streaming + Markdown + LaTeX), model picker, conversation history, selection toolbar, background `code_agent` dispatch |
| Deliberately absent | Computer Use (the ball's agent never drives other applications), and any second dsh install |

## How it differs from upstream (DeepSeek Orb)

| | Upstream DeepSeek Orb | This project |
|---|---|---|
| Delivery | A complete desktop app that bundles dsh | **Only the ball**, mounted into an existing DSH Desktop |
| Desktop shell | Electron | **Tauri 2 + Rust**, native windows, far smaller |
| Host | Ships its own host and Web UI | Reuses DSH's host: `sessionController`, `sessions`, `webServer`, `tools` |
| Main window | Ships the full dsh Web UI | None — you use your existing DSH window |
| Computer Use | Yes (13 GUI tools, screenshots, observation frame, coordinate encodings) | **No** |
| Platform | macOS + Windows | Windows only |
| Reading a selection | koffi calling the Win32 hook | Native Rust (low-level mouse hook + UI Automation), **no Ctrl+C fallback** |
| Rendering | React + micromark(GFM) + KaTeX + Shiki | Zero-dependency GFM renderer + KaTeX; **no syntax highlighting** |
| Install | Download an installer, or build the whole app | One script writes a row into the DSH profile; `--remove` uninstalls |
| Background work | Dual-track agent (foreground Computer Use + background code_agent) | Keeps background `code_agent` dispatch; no foreground GUI track |

## What was taken from upstream

Every borrowed idea, with its origin:

| Upstream | Borrowed | Used here |
|---|---|---|
| `apps/desktop/src/floating-window.ts` | Window geometry: 72 px ball, 320×420 panel, 12 px chrome, dock tab, occlusion rules | Ported to `desktop/src-tauri/src/geometry.rs`, with unit tests added |
| `apps/desktop/renderer/floating.css` | Visual baseline for panel, composer, drawers | Evolved into `web/bubble.css` |
| `apps/desktop/renderer/floating.js` | Interaction semantics: hover to expand, click to pin, drag, edge docking, three selection actions | Rewritten in `web/bubble.js` |
| Upstream selection approach | Global mouse hook plus a UI Automation read (upstream used koffi) | Reimplemented natively in Rust, with a different threading model |
| Upstream "dual-track agent" | Background `code_agent` running queued, reporting back to the ball | `src/host/code-agent.js` |
| Upstream assets | The ball's avatar | `web/assets/bubble.gif` |

Everything else — the Tauri shell, the plugin/host integration, selection polling and de-duplication, the
renderer, the diagnostics — was written for this fork.

## What this fork changed

**1. Plugin-ification (the point of the project).** The ball was extracted from the Electron app into a
relative-path DSH plugin: no `node_modules`, no `dsh plugin add`, only node built-ins and relative imports
(hence zero runtime dependencies). An install script writes the `cordis.patch.yml` insert row and supports
`--remove`; the shell exits when the host's stdin closes, so no orphan windows survive a crashed host.

**2. A Tauri/Rust shell written from scratch.** Window geometry and docking, dragging (using
`screenX/screenY`, because the window moves under the pointer), tray menu, single instance, a global mouse
hook, UI Automation selection reads, `ShellExecuteW` for links, and file-based diagnostics.

**3. Three fatal bugs found and fixed — each with measurements and a regression test.**

| Bug | Symptom | Root cause | Fix and measurement |
|---|---|---|---|
| Blocking hook thread | Laggy, drifting mouse pointer | Windows delivers `WH_MOUSE_LL` callbacks by messaging the thread that installed the hook, and that thread was sleeping in `recv_timeout(30ms)` | `GetMessageW` pump + non-blocking hand-off + separate dispatcher. 200 injected events: **6692 ms → 46 ms** (no-hook baseline 64 ms) |
| Self-recursive event name | The ball **and** the toolbar vanish, then reappear later | `handle.listen('bubble:selection')` is global, while the reveal re-emitted the same name → unbounded recursion → `0xC00000FD` stack overflow killed the process | Distinct delivery event, an atomic re-entrancy guard, and a 16 MB link stack (verified in the PE header). No `FATAL` line since |
| Toolbar stealing focus | The user's app lost focus, the window flickered grey, and the toolbar retired itself right after appearing | `window.show()` activates the window; with focus stolen, "does the focused element still have a selection?" was asking the toolbar itself, read nothing, and concluded the selection was gone | `WS_EX_NOACTIVATE`: the toolbar can never become the foreground window (it still receives clicks); the poll also declines to judge while our own process owns the foreground |

**4. The selection toolbar now follows the selection.** Drag-select or double-click a word → it appears.
Clear the selection (click, Escape, switch apps — any way) → it retires within 300 ms. Click outside it →
it retires. **The wheel, right clicks, and keys no longer dismiss it**, so copying via a context menu or
Ctrl+C still works. Asynchronous reads carry a generation number so a slow read cannot resurrect a toolbar
the user already dismissed.

**5. Browsers (and the DSH window itself) answered every read with nothing.** Chromium only builds its UI
Automation text provider once `UiaClientsAreListening()` is true, which flips as soon as any client registers
an event handler. A no-op focus listener on a dedicated STA thread with a message pump is the cheapest honest
way to say "a client is here".

**6. Panel interaction and visuals were rebuilt**: a header HUD (history, new, centred model pill, pin,
explicit close), model and history as overlay drawers (they used to squeeze the transcript), a pin toggle, a
token-usage badge, and a selection-quote chip.

**7. Rendering: Markdown + streaming + LaTeX.** `web/markdown.js` is a zero-dependency, pure-function GFM
renderer (headings, fenced code with language chip and copy button, blockquotes, nested lists, GFM task lists
and tables, rules, inline code/bold/italic/strikethrough/links/images/autolinks/escapes). **KaTeX 0.16** — the
same engine the main dsh session uses — is vendored with its fonts, so math works offline. Streaming deltas are
coalesced with `requestAnimationFrame`, the live bubble survives transcript rebuilds, the run settles only once
the committed message arrives, and reasoning folds into a "thinking…" block.

**8. Panel defects reported by users, each fixed with a regression test.**

| Symptom | Root cause | Fix |
|---|---|---|
| A newly arrived message did not scroll into view | When the live streaming bubble was still present, the transcript rebuild took the "gentle follow" branch — so a new message arrived **without** moving the viewport | Force-follow when the durable tail changed; streaming deltas still only follow when the reader is already at the bottom, plus a "↓ new message" button when they are not |
| Prompts sent while the agent was busy were invisible | The host **queues** such prompts, and a queued prompt is not a durable event, so the panel had nothing to render | The panel echoes the prompt as "sent, waiting for the agent" and retires the echo once the session log carries it |
| Questions from the agent were neither visible nor answerable | The upstream ball had question cards and the renderer rewrite dropped them; and `ctx.userQuestions` is a **single-provider** service owned by the DSH window | Detect a pending `ask_user_question` from `tool/call`, render the question and its options in the panel, and offer a one-click jump to the window that can answer (`bubble_focus_main`: locate the DSH window by application executable, then beat the Windows foreground lock with `AttachThreadInput`) |
| A long question pushed the "answer in the main window" button out of the panel | The panel is only 344×444 and the card grew with its content | The card is now a height-capped flex column: header and button stay put, only the question list scrolls |
| **Expanding or collapsing flashed the ball in the top-left corner** | The ball's base position *is* the window's top-left, and its docked corner only comes from the `body.expand-*` classes applied **after** the window resizes — so the frames in between showed a big window with the ball still in the corner | The ball and panel are hidden for exactly those frames (the window background is fully transparent, so nothing is visible instead of something misplaced), and the two Win32 calls behind `set_size` + `set_position` collapsed into a **single `SetWindowPos`**, removing the "old position, new size" frame at the source |
| Pressing Enter during those frames silently dropped the message | `promptText()` read the composer with `innerText`, which is **layout-dependent** and reads as empty while the panel is hidden | Fall back to `textContent` when the rendered text is empty but the source is not |

Two further defects fixed along the way, neither of them reported:

- **Chromium throttles `requestAnimationFrame` while the panel is collapsed**, so streamed answers were not
  rendered — and the ball is collapsed most of the time. Scheduling now runs on the next paint *or* 48 ms.
- **The first frame had no geometry yet**, so the ball flashed in the top-left on startup too. `<body>` now
  carries `layout-change` from the start and is revealed once the shell answers with the real geometry.

**9. Panel auto-collapse rules.** Pinned, running, dragging, a quoted selection, an open drawer, **focus inside
the panel**, or **the pointer inside the panel** all hold it open. The focus check must also consult the
*window's* focus: Chromium keeps `document.activeElement` on the composer after the window loses focus, so
trusting it alone meant the panel never collapsed again.

**10. Diagnostics and regressions.** `~/.dsh/dsh-bubble/shell.log` records lifecycle, exit codes, unhandled
exceptions, the selection timeline, and toolbar visibility. Six re-runnable checks:

```
node scripts/check-host.mjs       # host modules load
node scripts/smoke-host.mjs       # host HTTP surface: deltas, pending questions, static assets + content types
node scripts/check-markdown.mjs   # renderer as a pure function (52 assertions, incl. XSS cases)
node scripts/check-render.mjs     # real headless Chromium with real KaTeX, asserting the DOM (22 assertions)
node scripts/check-collapse.mjs   # panel collapse behaviour, driving the real panel headlessly (works offline)
node scripts/check-panel.mjs      # 34 assertions: new-message follow, queued echo, question card,
                                  #   long-question layout, and no misplaced frame during geometry changes
```

`check-collapse` was **mutation-tested**: removing the focus guard fails case 1; removing the window-focus
guard fails case 2. `check-panel` is no decoration either — it caught three real bugs while it was being
written (no jump on a new message, unthrottled render, and `innerText` reading empty during a geometry change
so the typed message was dropped); the last one surfaced as its own flakiness before it was understood.

Every probe also asserts that it is testing the **working tree**: if the plugin's HTTP copy serves an older
probe, or the executable embeds a panel older than `web/`, the check says so instead of reporting a result.
That class of "tested stale code" mistake happened twice in this project, which is why the guards exist.

## Install

Requirements: **DeepSeek Harness Desktop** (the ball is its plugin; no second dsh), Node ≥ 22, and a Rust
toolchain for the shell.

```powershell
git clone git@github.com:jiang585/dsh-bubble.git
cd dsh-bubble

# build the desktop shell (first run compiles Rust dependencies, ~2 minutes)
cargo build --release --manifest-path desktop/src-tauri/Cargo.toml
node scripts/copy-desktop.mjs

# mount it in the DSH profile (adds one patch row, backing the file up first)
node scripts/install-profile.mjs
```

Then **fully quit and reopen DSH Desktop** (quit from the tray; closing the window is not enough). To remove:

```powershell
node scripts/install-profile.mjs --remove
```

## Configuration (the insert row in `cordis.patch.yml`)

| Key | Default | Meaning |
|---|---|---|
| `basePath` | `/dsh-bubble` | API prefix for the ball |
| `stateDir` | `~/.dsh/dsh-bubble` | Window position, preferences, current session, diagnostics |
| `workspaceName` | `dsh_bubble` | Workspace directory for the ball (under `$DSH_HOME`) |
| `frontPreset` | `standard` | Agent preset used by the ball's conversation |
| `autoStart` | `true` | Whether DSH shows the ball on startup |
| `selectionToolbar` | `true` | Whether to install the global mouse hook for the selection toolbar |
| `desktopExecutable` | empty | Explicit shell executable; empty auto-discovers `desktop/dist/` and the cargo target |
| `token` | empty | Random per host start when empty; only pinned for tests |

The tray menu has a 划词工具条 checkbox that takes effect **immediately** (the hook stays installed but
returns early), so no restart is needed.

## Known limitations

- Windows only.
- **No Computer Use**: the ball's agent cannot drive other applications.
- The selection toolbar reads through UI Automation only and **never falls back to Ctrl+C**, so it cannot
  interrupt a running command in a console window — at the cost of some controls (those without an
  accessibility provider) not being readable.
- **No syntax highlighting** in code blocks: upstream uses Shiki (WASM plus grammar bundles), which is a poor
  fit for a build-free static page. Code blocks do get a language chip, monospace, and a copy button.
- Markdown covers the common CommonMark + GFM subset; no footnotes or definition lists, and inline HTML is
  escaped rather than executed.
- The history list only shows **live** ball sessions: dsh 0.1.7's `SessionPersistence` has no `inspect` or
  `listSnapshots`.
- Model choice is per session (`saveAsDefault: false`); it does not change the deployment default.
- Completion reports arrive as **a notice on the ball**, not as a follow-up message that re-drives the
  foreground agent — that would require building a full `UserMessage`, and this plugin may not import
  `@deepseek-ai/dsh-llm`.

## Layout

```
src/host/          plugin host (zero dependencies: node built-ins and relative imports)
  index.js         mount: store / conversation / SSE / desktop process / routes / tools
  bubble.js        the ball's conversation: transcript, streaming, model, history, usage
  routes.js        /state /message /models /history /selection /events … (all token-guarded with CORS preflight)
  code-agent.js    the code_agent tool: dispatch a background session, report back to the ball
  desktop.js       shell process lifecycle: resolve the executable, environment, watchdog, bounded restarts
  store.js         atomic JSON in the state directory
  http.js          CORS preflight, SSE hub, static files
desktop/src-tauri/ Tauri 2 shell (Rust)
  main.rs          windows, tray, commands, single instance, crash logging
  geometry.rs      window geometry (ported from upstream, unit-tested)
  selection.rs     global mouse hook + UI Automation + the selection toolbar
web/               the panel page (build-free static assets)
  bubble.js/css    ball and panel
  markdown.js      GFM renderer (pure functions, unit-testable)
  vendor/katex/    vendored KaTeX
  dev/             probe pages used by the checks
scripts/           install, build, and verification scripts
```

## License

[MIT](LICENSE), **inherited from upstream DeepSeek Orb**, which in turn inherits it from DeepSeek Harness.
The original copyright notice `Copyright (c) 2026 DeepSeek` is retained in full as the MIT terms require, and
the derivative work is marked `Copyright (c) 2026 jiang585`. Third-party components are listed at the end of
[LICENSE](LICENSE).
