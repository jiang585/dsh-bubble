/**
 * Drive the panel behaviour probe through headless Chromium.
 *
 * The probe page (web/dev/panel-probe.html) mounts the real panel in an iframe with a faked desktop
 * bridge and a faked SSE stream, then asserts the three behaviours a user reported broken: new
 * messages must scroll into view, a prompt sent while the agent is busy must be visible immediately,
 * and a pending question must be surfaced with a way to answer it.
 *
 * Run: node scripts/check-panel.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/** Port the plugin's web server listens on. */
const PORT = Number(process.env.BUBBLE_PORT ?? 19387)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localProbe = join(root, 'web', 'dev', 'panel-probe.html')

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
  console.error('check-panel: no Chromium browser found; set BUBBLE_BROWSER to one')
  process.exit(1)
}

// Always drive the working tree over file://.
//
// The probe writes the panel into a same-origin iframe with `document.write`. When that page is served
// over HTTP the panel's percentage-height chain does not resolve inside the written document, so it
// measures a content-sized panel and reports layout failures that the real ball does not have (the ball
// loads the embedded panel at the top level of its own webview). Layout assertions therefore need the
// deterministic file:// mode; `scripts/smoke-host.mjs` covers the HTTP surface instead.
const target = `${pathToFileURL(localProbe).href}?v=${Date.now()}`
const fileMode = true
if (!existsSync(localProbe)) {
  console.error(`check-panel: ${localProbe} is missing`)
  process.exit(1)
}

let dom
const profile = `${process.env.TEMP ?? '.'}\\bubble-panel-probe`
rmSync(profile, { recursive: true, force: true })
try {
  dom = execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=30000',
    // Needed only in the file:// fallback, where the probe mounts the panel page from its sibling.
    ...(fileMode ? ['--allow-file-access-from-files'] : []),
    '--dump-dom',
    target,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 })
} catch (error) {
  console.error('check-panel: the browser run failed')
  console.error(String(error?.stderr ?? error?.message ?? error))
  process.exit(1)
}

const lines = dom
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^(ok|FAIL|pushes|result)/u.test(line))

console.log('dsh-bubble panel probe:')
for (const line of lines) console.log(`  ${line}`)

if (!/data-result="pass"/u.test(dom)) {
  console.error('\ncheck-panel: the panel did not behave as required')
  process.exit(1)
}
console.log('\ncheck-panel: ok')
