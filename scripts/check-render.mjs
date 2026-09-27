/**
 * Render the ball's markdown pipeline in a real browser and assert on the produced DOM.
 *
 * `check-markdown.mjs` covers the renderer as a pure function; this closes the gap between that and
 * what the panel actually shows, because it loads the vendored KaTeX and the real stylesheet in
 * Chromium and inspects the resulting document.
 *
 * Run: node scripts/check-render.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = join(root, 'web', 'dev', 'markdown-probe.html')

/** Locate a Chromium build without touching the user's profile. */
function findBrowser() {
  const candidates = [
    process.env.BUBBLE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  return candidates.find((candidate) => existsSync(candidate))
}

const browser = findBrowser()
if (browser === undefined) {
  console.error('check-render: no Chromium browser found; set BUBBLE_BROWSER to one')
  process.exit(1)
}

const profile = join(process.env.TEMP ?? process.env.TMP ?? '.', 'bubble-render-probe')
let dom
try {
  dom = execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=4000',
    '--dump-dom',
    `file:///${page.replace(/\\/gu, '/')}`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 })
} catch (error) {
  console.error(`check-render: could not run ${browser}`)
  console.error(String(error?.stderr ?? error?.message ?? error))
  process.exit(1)
}

let failures = 0
let checks = 0

// Only the rendered container is inspected: the probe page's own <script> source also contains the
// hostile-looking sample, which would otherwise satisfy an "is it escaped?" search.
const containerStart = dom.indexOf('id="out"')
const containerEnd = dom.indexOf('<script src="../vendor/katex/katex.min.js"')
const rendered = containerStart >= 0 && containerEnd > containerStart ? dom.slice(containerStart, containerEnd) : dom

/**
 * Assert something about the rendered container.
 * @param name - Case name.
 * @param expected - Substring or predicate.
 * @param haystack - Text to search; the rendered container by default.
 */
function check(name, expected, haystack = rendered) {
  checks += 1
  const ok = typeof expected === 'function' ? expected(haystack) : haystack.includes(expected)
  if (ok) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}`)
}

console.log('dsh-bubble render (headless Chromium):')
check('probe executed', 'data-probe="done"', dom)
check('heading', '<h1>一级标题</h1>')
check('bold', '<strong>加粗</strong>')
check('inline code', '<code>行内代码</code>')
check('strikethrough', '<del>删除线</del>')
check('link', 'href="https://example.com"')
check('inline tex became katex', (html) => html.includes('class="katex"'))
check('inline tex produced mathml', '<math')
check('inline tex kept its glyphs', (html) => html.includes('katex-html') && /\ba\b/u.test(html))
check('display tex became katex-display', 'katex-display')
check('display tex survived a fraction', (html) => html.includes('mfrac') || html.includes('frac'))
check('table', (html) => html.includes('<table>') && html.includes('<thead>'))
check('table alignment', 'text-align: right')
check('blockquote', '<blockquote>')
check('checked task', (html) => html.includes('type="checkbox"') && html.includes('checked'))
check('nested list', (html) => (html.match(/<ul>/gu) ?? []).length >= 2)
check('code block with copy', (html) => html.includes('class="language-js"') && html.includes('data-copy'))
check('code content intact', 'const answer = 42')
check('thematic break', '<hr>')
check('raw html stayed escaped', (html) => html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'))
check('no katex error markup', (html) => !html.includes('katex-error'))
check('leaked html would be a real element', (html) => !/<img[^>]*onerror/iu.test(html))

console.log(`\n${checks - failures}/${checks} passed`)
if (failures > 0) {
  console.error(`${failures} render check(s) failed`)
  process.exit(1)
}
