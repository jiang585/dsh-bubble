# dsh-bubble

**把悬浮球单独做成 DSH 插件——不再重复安装一份 dsh 本体。**

[English](README.md) | 中文

屏幕边缘停一颗球。悬停展开面板，直接对话；在任意应用里划选文字，弹出「搜索 / 翻译 / 发给 Agent」；
复杂任务派给后台代码会话跑完再回到球里。它挂在**你已经装好的 DeepSeek Harness Desktop** 上，
不打包 dsh、不新建 Host、不装 Electron。

> 本项目是 [DeepSeek Orb](https://github.com/mini-yifan/deepseek-harness-orb) 的**二次开发**，
> 只取其中的悬浮球部分，从 Electron 应用改造为 DSH 插件。
> 上游又基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh 0.1.7）构建。
> 与 DeepSeek AI 没有隶属关系。

## 它是什么

| | |
|---|---|
| 形态 | DSH 插件（相对路径加载，零运行时依赖），宿主是 DSH Desktop |
| 桌面壳 | Tauri 2 + Rust 原生窗口（`dsh-bubble-shell.exe`，约 12 MB） |
| 平台 | 只 Windows |
| 球上能力 | 对话（流式 + Markdown + LaTeX）、模型选择、历史会话、划词工具条、后台派发 `code_agent` |
| 明确不做 | Computer Use（球上的 agent 不操作其他应用的界面）、重复安装 dsh 本体 |

## 与原项目（DeepSeek Orb）的不同

| 维度 | 上游 DeepSeek Orb | 本项目 dsh-bubble |
|---|---|---|
| 交付形态 | 自带 dsh 本体的完整桌面应用，装它等于装一套 | **只做悬浮球**，作为插件挂进已有的 DSH Desktop，无需再装 dsh |
| 桌面壳 | Electron | **Tauri 2 + Rust**，原生窗口，体积小得多 |
| 宿主 | 自带 Host / Web UI 整套 | 复用 DSH 自带宿主：`sessionController`、`sessions`、`webServer`、`tools` |
| 主窗口 | 自带完整 dsh Web UI | 没有，用你现成的 DSH 窗口 |
| Computer Use | 有（13 个 GUI 工具、截图、观察边框、坐标编码） | **不做**，球上的 agent 不能操作其它应用 |
| 平台 | macOS + Windows | 只 Windows |
| 划词读选区 | koffi 调 Win32 钩子 | Rust 原生实现（低层鼠标钩子 + UI Automation），**不做 Ctrl+C 兜底** |
| 渲染 | React + micromark(GFM) + KaTeX + Shiki 高亮 | 零依赖自写 GFM 渲染器 + KaTeX；**无语法高亮** |
| 安装 | 下载安装包 / 从源码构建整个 app | 一条脚本写进 DSH profile，纯文件式，可 `--remove` 卸载 |
| 后台派发 | 双轨 Agent（前台 Computer Use + 后台 code_agent） | 保留后台派发 `code_agent`，无前台 GUI 轨 |

## 参考了上游什么

诚实列清出处——这些地方是从上游读代码后移植或对齐的：

| 上游位置 | 参考内容 | 本项目的落地 |
|---|---|---|
| `apps/desktop/src/floating-window.ts` | 窗口几何：球 72、面板 320×420、chrome 12、贴边细条与遮挡判定 | 移植为 `desktop/src-tauri/src/geometry.rs`，并补了单元测试 |
| `apps/desktop/renderer/floating.css` | 面板、输入胶囊、抽屉的视觉基线 | `web/bubble.css` 由它演化而来 |
| `apps/desktop/renderer/floating.js` | 交互语义：悬停展开、单击固定、拖拽、贴边停靠、划词三段动作 | 在 `web/bubble.js` 中重写实现 |
| 上游划词方案 | 全局鼠标钩子 + UI Automation 读选区（上游用 koffi） | 改为 Rust 原生实现，并重做了线程模型 |
| 上游「双轨 Agent」 | 后台 `code_agent` 排队执行、完成回球 | `src/host/code-agent.js` |
| `apps/desktop/build/icon.png` 等素材 | 球的头像 | `web/assets/bubble.gif` 沿用上游素材 |

上游没有的部分（Tauri 壳、插件宿主对接、测选轮询与去重、渲染器、诊断体系）都是本项目新写的。

## 我做了什么

**1. 插件化（核心目标）**

把球从 Electron 应用里拆出来，做成 DSH 的相对路径插件：不写 `node_modules`、不跑 `dsh plugin add`，
只用 node 内置模块 + 相对 import（因此**零运行时依赖**）。自带安装脚本写 `cordis.patch.yml` 的 insert 行，
支持 `--remove`；球随宿主进程退出（stdin EOF 看门狗），不会留下孤儿窗口。

**2. Tauri / Rust 桌面壳（从零写）**

窗口几何与停靠、拖拽（用 `screenX/screenY`，避免窗口移动后指针坐标漂移）、托盘菜单、
单实例、全局鼠标钩子、UI Automation 读选区、`ShellExecuteW` 打开链接、诊断日志。

**3. 修掉三个致命问题（都有实测数据与回归测试）**

| 问题 | 现象 | 根因 | 修法与实测 |
|---|---|---|---|
| 钩子线程阻塞 | 鼠标发卡、指针发飘 | `WH_MOUSE_LL` 回调靠给装钩子的线程发消息，而那个线程在 `recv_timeout(30ms)` 里睡觉 | 改为 `GetMessageW` 泵 + 非阻塞投递 + 独立 dispatcher。200 次注入事件：**6692ms → 46ms**（无钩子基线 64ms） |
| 事件名自我递归 | 球和工具条**一起消失**，过一会儿又出现 | `handle.listen('bubble:selection')` 是全局监听，而 show 里又 `emit` 同名事件 → 无限递归 → `0xC00000FD` 栈溢出杀进程 | 投递改独立事件名 + 原子重入保护 + 链接栈 1MB→16MB（PE 头已核对）。修复后日志再无 `FATAL` |
| 工具条抢焦点 | 应用失焦、窗口灰闪、工具条刚出现就自己收起 | `window.show()` 会激活窗口；抢到焦点后"当前聚焦元素还有没有选中"问的是工具条自己，读空即误判选区消失 | `WS_EX_NOACTIVATE`：工具条永不成为前台窗口（仍收鼠标点击）；轮询在前台属于本进程时不下结论 |

**4. 划词工具条按「选区生命周期」工作**

拖拽选中 / 双击选词 → 出现；选区被清空（点击、Esc、切窗口，任何方式）→ 300ms 内消失；
左键点工具条外 → 收起。**滚轮、右键、按键不再误收**（右键复制、Ctrl+C 都能用）。
异步读取用世代号去重，慢读返回时若已过期就丢弃——否则"已收起的工具条会被迟到的读取重新点亮"。

**5. Chromium 系应用读不到选区**

Chromium（Edge、以及 DSH 本体的 Electron 窗口）只在 `UiaClientsAreListening()` 为真时才构建 UIA
文本提供者。本项目注册一个空焦点监听器（独立 STA 线程 + 消息泵）让系统认为有辅助技术客户端在，
浏览器窗口才开始回应文本读取。

**6. 面板交互与视觉重构**

顶部控制台（历史 / 新建 / 居中的模型胶囊 / 固定 / 显式关闭）、模型与历史改为**浮层抽屉**（此前与对话区
互相挤压）、固定开关、Token 用量徽章、划词引用条。

**7. 渲染：Markdown + 流式 + LaTeX**

`web/markdown.js` 是零依赖、纯函数的 GFM 渲染器（标题、围栏代码含语言标签与复制、引用、嵌套列表、
GFM 任务列表与表格、分隔线、行内代码/加粗/斜体/删除线/链接/图片/自动链接/转义）；内置 **KaTeX 0.16**
（与 dsh 本体同款引擎、含字体，离线可用）；流式增量用 `requestAnimationFrame` 合并，
直播气泡跨 transcript 重建存活，运行结束等最终消息到达再收尾，思考过程折成「思考中…」。

**8. 面板的三个实际缺陷（用户反馈后定位并修复，均带回归测试）**

| 现象 | 根因 | 修法 |
|---|---|---|
| 收到新消息不跳到最新 | 重建 transcript 时若流式气泡还在，走的是"温和跟随"分支——新消息来了却不跳 | 改为按**末尾是否变化**判定：新消息一律强制跳转；流式增量仍只在你本来就在底部时跟随，并加"↓ 有新消息"提示按钮 |
| 连发消息时看不到自己发的内容 | 运行中发送的消息由宿主**排队**，而排队不是持久事件，面板无从渲染 | 面板本地回显"已发出，等待 Agent 处理…"，会话记录一旦出现该消息就自动撤销回显 |
| 被提问时既看不到问题也无法回答 | 上游悬浮球本来有问答卡片，重写渲染层时丢了；且 `ctx.userQuestions` 是**单槽位服务**，答题方归 DSH 主窗口所有 | 从 `tool/call` 事件侦测待回答的 `ask_user_question`，在面板显示问题与选项，并提供"去 DSH 主窗口回答"一键跳转（新增 `bubble_focus_main`：按父进程定位 DSH 主窗口并激活） |

顺带修掉一个无人报告但真实存在的问题：**面板收起时 Chromium 会节流 `requestAnimationFrame`**，
导致流式内容不渲染——而球大部分时间是收起的。改为"下一帧执行，但最迟 48ms"的调度。

**9. 面板收起规则**

固定在/运行中/拖动中/有划词引用/抽屉打开/**焦点在面板**/**指针在面板** → 都不自动收起。
其中"焦点"必须同时看**窗口焦点**：Chromium 在窗口失焦时不会改变 `activeElement`，
只看它会导致切走应用后永远不收起。

**10. 诊断与回归体系**

`~/.dsh/dsh-bubble/shell.log` 记录启停、退出码、未处理异常、划词时间线、工具条显隐；
6 个可复跑校验：

```
node scripts/check-host.mjs       # 宿主模块加载
node scripts/smoke-host.mjs       # 宿主 HTTP 全链路 + 流式 delta + 待回答提问侦测
node scripts/check-markdown.mjs   # 渲染器纯函数断言（52 项，含 XSS 用例）
node scripts/check-render.mjs     # 真实无头 Chromium + 真实 KaTeX 断言 DOM（22 项）
node scripts/check-collapse.mjs   # 面板收起行为（无头 Chromium 驱动真实面板，可离线跑）
node scripts/check-panel.mjs      # 新消息跳转 / 排队回显 / 提问卡片（16 项断言）
```

`check-collapse` 做过**变异验证**：删掉焦点判断 → 用例 1 失败；删掉窗口焦点判断 → 用例 2 失败；
恢复即通过。`check-panel` 同样在开发中真实抓到两个 bug（新消息不跳转、rAF 被节流不渲染），
不是写完就绿的摆设。

## 安装

前置：已安装 **DeepSeek Harness Desktop**（球是它的插件，不重复装 dsh）、Node ≥ 22（构建壳需要 Rust 工具链）。

```powershell
git clone git@github.com:jiang585/dsh-bubble.git
cd dsh-bubble

# 构建桌面壳（首次会编译 Rust 依赖，约 2 分钟）
cargo build --release --manifest-path desktop/src-tauri/Cargo.toml
node scripts/copy-desktop.mjs

# 装进 DSH profile（会在 cordis.patch.yml 里加一行，并备份原文件）
node scripts/install-profile.mjs
```

然后**完全退出并重开 DSH Desktop**（托盘退出，关窗口不算）。卸载：

```powershell
node scripts/install-profile.mjs --remove
```

## 配置（`cordis.patch.yml` 里的 insert 行）

| 键 | 默认 | 说明 |
|---|---|---|
| `basePath` | `/dsh-bubble` | 球的 API 前缀 |
| `stateDir` | `~/.dsh/dsh-bubble` | 窗口位置、偏好、当前会话、诊断日志 |
| `workspaceName` | `dsh_bubble` | 球的工作区目录（`$DSH_HOME` 下） |
| `frontPreset` | `standard` | 球上对话使用的 agent preset |
| `autoStart` | `true` | DSH 启动时是否自动显示球 |
| `selectionToolbar` | `true` | 是否安装全局鼠标钩子以启用划词工具条 |
| `desktopExecutable` | 空 | 显式指定壳 exe；空则自动找 `desktop/dist/` 与 cargo target |
| `token` | 空 | 留空则每轮随机；仅为测试固定 |

托盘菜单里有「划词工具条」勾选项，关掉**即刻生效**（钩子保留但直接返回），不用重启。

## 已知限制

- 只支持 Windows。
- **没有 Computer Use**：球上的 agent 不能操作其他应用的界面。
- 划词工具条只走 UI Automation 读选区，**不做 Ctrl+C 兜底**：读不到就不弹工具条，这样不会在终端里
  误触发中断，代价是部分应用（未开启无障碍的控件等）选不中。
- 代码块**不做语法高亮**：上游用 Shiki（需要 WASM 与语法包），塞进免构建的静态页面不划算；
  现在有语言标签、等宽字体与复制按钮。
- Markdown 覆盖常用 CommonMark + GFM 子集，不含脚注、定义列表；HTML 内嵌会被转义而不是执行。
- 历史列表只列**活着的**球会话：dsh 0.1.7 的 `SessionPersistence` 没有 `inspect`/`listSnapshots`。
- 模型选择按会话生效（`saveAsDefault: false`），不写部署默认。
- 完成回球是**球上的一则通知**，不作为 follow-up 消息重新驱动前台 agent（那需要构造完整的 `UserMessage`，
  而本插件不允许导入 `@deepseek-ai/dsh-llm`）。

## 工程结构

```
src/host/          插件宿主（零依赖，node 内置模块 + 相对 import）
  index.js         挂载：store / conversation / SSE / 桌面进程 / 路由 / 工具
  bubble.js        球上会话：transcript、流式、模型、历史、用量
  routes.js        /state /message /models /history /selection /events …（全部过 token 与 CORS 预检）
  code-agent.js    code_agent 工具：派发后台会话、完成回球
  desktop.js       壳进程生命周期：解析 exe、环境变量、看门狗、有界重启
  store.js         状态目录的原子 JSON
  http.js          CORS 预检、SSE 集线器、静态文件
desktop/src-tauri/ Tauri 2 壳（Rust）
  main.rs          窗口、托盘、命令、单实例、异常日志
  geometry.rs      窗口几何（移植自上游，带单测）
  selection.rs     全局鼠标钩子 + UI Automation + 划词工具条
web/               面板页面（免构建静态资源）
  bubble.js/css    球与面板
  markdown.js      GFM 渲染器（纯函数、可单测）
  vendor/katex/    内置 KaTeX
  dev/             校验用的探针页面
scripts/           安装、构建、校验脚本
```

## 许可

[MIT](LICENSE)，**继承上游 DeepSeek Orb**（其又继承自 DeepSeek Harness）。原始版权声明
`Copyright (c) 2026 DeepSeek` 依 MIT 条款完整保留，二次开发部分标注 `Copyright (c) 2026 jiang585`。
第三方组件许可见 [LICENSE](LICENSE) 末尾。
