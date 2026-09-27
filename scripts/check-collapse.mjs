/**
 * Drive the panel's auto-collapse regression probe through headless Chromium.
 *
 * The probe page (web/dev/collapse-probe.html) mounts the real panel in an iframe and reports whether
 * the panel survives the pointer leaving while the composer holds focus. It is loaded from the running
 * plugin when that is up, and straight from the working tree otherwise, so the check never depends on
 * a live DSH.
 *
 * Run: node scripts/check-collapse.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/** Port the plugin's web server listens on. */
const PORT = Number(process.env.BUBBLE_PORT ?? 19387)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localProbe = join(root, 'web', 'dev', 'collapse-probe.html')

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
  console.error('check-collapse: no Chromium browser found; set BUBBLE_BROWSER to one')
  process.exit(1)
}

// Cache-busting query: headless Chromium reuses the probe profile between runs and would otherwise
// keep executing yesterday's probe page.
let target = `http://127.0.0.1:${PORT}/dsh-bubble/dev/collapse-probe.html?v=${Date.now()}`
let fileMode = false
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  // The plugin serves its installed copy. If that copy is not the working tree, the run would exercise
  // stale code and report a false result, so compare before trusting it.
  const served = (await response.text()).replaceAll('\r\n', '\n')
  const working = readFileSync(localProbe, 'utf8').replaceAll('\r\n', '\n')
  if (served !== working) throw new Error('the installed probe differs from the working tree')
} catch (error) {
  if (!existsSync(localProbe)) {
    console.error(`check-collapse: the plugin is not serving the panel and ${localProbe} is missing`)
    process.exit(1)
  }
  target = `${pathToFileURL(localProbe).href}?v=${Date.now()}`
  fileMode = true
  console.log(`check-collapse: using the working tree over file:// (${error.message})`)
}

let dom
const profile = `${process.env.TEMP ?? '.'}\\bubble-collapse-probe`
rmSync(profile, { recursive: true, force: true })
try {
  dom = execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    // The probe waits ~3.4s of real time; virtual time keeps the headless run short and deterministic.
    '--virtual-time-budget=20000',
    // Needed only in the file:// fallback, where the probe mounts the panel page from its sibling.
    ...(fileMode ? ['--allow-file-access-from-files'] : []),
    '--dump-dom',
    target,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 })
} catch (error) {
  console.error('check-collapse: the browser run failed')
  console.error(String(error?.stderr ?? error?.message ?? error))
  process.exit(1)
}

const lines = dom
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^(expanded|unpinned|composer|with|after|diagnostics|result|FAIL)/u.test(line))

console.log('dsh-bubble collapse probe:')
for (const line of lines) console.log(`  ${line}`)

const pass = /data-result="pass"/u.test(dom)
if (!pass) {
  console.error('\ncheck-collapse: the panel did not behave (focus must hold it open, blur must collapse it)')
  process.exit(1)
}
console.log('\ncheck-collapse: ok')
