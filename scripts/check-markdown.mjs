/**
 * Assertions for the ball's markdown renderer.
 *
 * The renderer is a pure string transform, so it is checked here in plain node - no DOM, no
 * dependencies - which keeps the panel's rendering honest without a browser in the loop.
 *
 * Run: node scripts/check-markdown.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The renderer is a browser classic script that also publishes itself on globalThis, which is how
// this test picks it up (the package is `type: module`, so the CJS branch never applies here).
await import(pathToFileURL(join(root, 'web', 'markdown.js')).href)
const { render, renderInline, escapeHtml } = globalThis.BubbleMarkdown

let failures = 0
let checks = 0

/**
 * Assert one case.
 * @param name - Case name.
 * @param actual - Produced HTML.
 * @param expected - Substring the HTML must contain, or a predicate receiving the HTML.
 */
function check(name, actual, expected) {
  checks += 1
  const ok = typeof expected === 'function' ? expected(actual) : actual.includes(expected)
  if (ok) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}`)
  console.log(`      got: ${actual}`)
}

console.log('dsh-bubble markdown:')

// ---------------------------------------------------------------- inline
check('bold', renderInline('a **b** c'), '<strong>b</strong>')
check('emphasis', renderInline('a *b* c'), '<em>b</em>')
check('strikethrough', renderInline('a ~~b~~ c'), '<del>b</del>')
check('inline code', renderInline('use `x = 1` here'), '<code>x = 1</code>')
check('inline code keeps markup literal', renderInline('`**not bold**`'), (html) => html.includes('<code>**not bold**</code>') && !html.includes('<strong>'))
check('link', renderInline('[docs](https://example.com/a)'), '<a href="https://example.com/a"')
check('link has noopener', renderInline('[d](https://example.com)'), 'rel="noreferrer noopener"')
check('autolink', renderInline('see https://example.com now'), '<a href="https://example.com"')
check('image', renderInline('![alt](https://example.com/i.png)'), '<img src="https://example.com/i.png"')
check('backslash escape', renderInline('a \\*b\\* c'), (html) => html.includes('*b*') && !html.includes('<em>'))

// ---------------------------------------------------------------- safety
check('raw html is escaped', render('<img src=x onerror=alert(1)>'), (html) => html.includes('&lt;img') && !html.includes('<img src=x'))
check('script tag is escaped', render('<script>alert(1)</script>'), (html) => !html.includes('<script>'))
check('javascript: link is refused', render('[x](javascript:alert(1))'), (html) => !html.includes('href="javascript'))
check('data: image is refused', render('![x](data:text/html;base64,PHNjcmlwdD4=)'), (html) => !html.includes('<img'))
check('quote in text is escaped', render('he said "hi"'), '&quot;hi&quot;')

// ---------------------------------------------------------------- blocks
check('heading levels', render('# H1\n\n### H3'), (html) => html.includes('<h1>H1</h1>') && html.includes('<h3>H3</h3>'))
check('thematic break', render('a\n\n---\n\nb'), '<hr>')
check('fenced code', render('```js\nconst a = 1\n```'), (html) => html.includes('class="language-js"') && html.includes('const a = 1'))
check('fenced code is not formatted', render('```\n**x**\n```'), (html) => html.includes('**x**') && !html.includes('<strong>'))
check('fenced code escapes html', render('```\n<script>\n```'), (html) => html.includes('&lt;script&gt;'))
check('tilde fence', render('~~~\nx\n~~~'), '<code>x</code>')
check('copy button present', render('```\nx\n```'), 'data-copy')
check('unterminated fence while streaming', render('```js\nconst a'), (html) => html.includes('const a'))
check('blockquote', render('> quoted'), '<blockquote>')
check('nested blockquote', render('> a\n>\n> > b'), (html) => (html.match(/<blockquote>/gu) ?? []).length === 2)
check('unordered list', render('- a\n- b'), (html) => html.includes('<ul>') && (html.match(/<li>/gu) ?? []).length === 2)
check('ordered list', render('1. a\n2. b'), '<ol>')
check('nested list', render('- a\n  - b'), (html) => html.includes('<ul>') && (html.match(/<ul>/gu) ?? []).length === 2)
check('task list unchecked', render('- [ ] todo'), (html) => html.includes('type="checkbox"') && !html.includes('checked'))
check('task list checked', render('- [x] done'), (html) => html.includes('checked'))
check('table', render('| a | b |\n| --- | --- |\n| 1 | 2 |'), (html) => html.includes('<thead>') && html.includes('<td>1</td>'))
check('table alignment', render('| a | b |\n| :--- | ---: |\n| 1 | 2 |'), (html) => html.includes('text-align: left') && html.includes('text-align: right'))
check('table cell formatting', render('| a |\n| --- |\n| **b** |'), '<strong>b</strong>')
check('paragraph soft break', render('a\nb'), (html) => html.includes('a\nb') && !html.includes('<br>'))
check('paragraph hard break', render('a  \nb'), '<br>')

// ---------------------------------------------------------------- math
const mathCalls = []
const katexLike = (tex, display) => {
  mathCalls.push({ tex, display })
  return `<span class="katex-math">${escapeHtml(tex)}</span>`
}
check('inline math', render('area is $a^2$ ok', { math: katexLike }), '<span class="katex-math">a^2</span>')
check('display math same line', render('$$x^2$$', { math: katexLike }), 'class="katex-math"')
check('display math block', render('$$\nx^2\n$$', { math: katexLike }), 'math-display')
check('paren math', render('\\(a+b\\)', { math: katexLike }), '<span class="katex-math">a+b</span>')
check('bracket math', render('\\[a+b\\]', { math: katexLike }), 'class="katex-math"')
check('dollar amounts stay prose', render('costs $5 and $10 total', { math: katexLike }), (html) => html.includes('$5 and $10'))
check('escaped dollar is literal', render('price \\$9', { math: katexLike }), '$9')
check('math inside list', render('- item $x$', { math: katexLike }), 'katex-math')
check('math inside table', render('| $x$ |\n| --- |\n| $y$ |', { math: katexLike }), 'katex-math')
check('display math keeps newlines in tex', (() => {
  mathCalls.length = 0
  render('$$\na\nb\n$$', { math: katexLike })
  return mathCalls.some((call) => call.tex === 'a\nb' && call.display === true) ? 'yes' : 'no'
})(), 'yes')
check('math fallback without renderer', render('$x^2$'), '<code class="math-raw">x^2</code>')
check('broken tex does not throw', render('$x$', { math: () => { throw new Error('boom') } }), '<code class="math-raw">x</code>')
check('math result is not re-parsed', render('$a*b$', { math: katexLike }), (html) => !html.includes('<em>'))

// ---------------------------------------------------------------- streaming shape
const partial = ['## 标题\n', '\n', '正在生成的段落 **加粗** 和 ']
check('partial markdown stays parseable', render(partial.join('')), (html) => html.includes('<h2>标题</h2>') && html.includes('<strong>加粗</strong>'))
check('streaming partial fence', render('```py\nprint(1)'), 'print(1)')
check('cjk strong', render('**中文加粗**'), '<strong>中文加粗</strong>')
check('cjk with punctuation', render('这是**重点**内容'), '这是<strong>重点</strong>内容')

console.log(`\n${checks - failures}/${checks} passed`)
if (failures > 0) {
  console.error(`${failures} markdown check(s) failed`)
  process.exit(1)
}
