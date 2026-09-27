/**
 * Install or remove the floating ball in a DSH profile.
 *
 * The plugin is mounted as a relative-path module from the profile's `plugins/` directory, so no
 * npm install, no `node_modules` entry, and no `dsh plugin add` are required. The profile's
 * `cordis.patch.yml` gains one `insert` row; every other row is left byte-identical.
 *
 * `node scripts/install-profile.mjs [--remove] [--profile <dir>]`
 *
 * @module dsh-bubble/scripts/install-profile
 */

import { cp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALL_NAME = 'dsh-bubble'
const ROW_ID = 'dsh-bubble'

/**
 * Identifiers this plugin used before it was renamed from dsh-orb.
 *
 * Every install sweeps them: leaving the old insert row or its plugin directory behind would mount
 * the plugin twice and put two floating balls on screen.
 */
const LEGACY_ROW_IDS = ['dsh-orb']
const LEGACY_INSTALL_NAMES = ['dsh-orb']
/** Executables to stop before copying: the current shell plus every name it shipped under. */
const SHELL_PROCESSES = ['dsh-bubble-shell.exe', 'dsh-orb-desktop.exe', 'dsh-orb-shell.exe']

/** Package entries copied into the profile. */
const ENTRIES = ['src', 'web', 'desktop/dist', 'package.json', 'cordis.patch.yml', 'README.md']

const argv = process.argv.slice(2)
const remove = argv.includes('--remove')
const profileFlag = argv.indexOf('--profile')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = resolve(
  profileFlag === -1 ? join(dshHome, 'profiles', 'desktop') : argv[profileFlag + 1],
)

const patchPath = join(profileDir, 'cordis.patch.yml')
const pluginDir = join(profileDir, 'plugins', INSTALL_NAME)

/** Stop a running ball shell: Windows keeps the copied executable locked while it runs. */
function stopRunningShell() {
  for (const process of SHELL_PROCESSES) {
    try {
      execFileSync('taskkill', ['/IM', process, '/F'], { stdio: 'ignore' })
      console.log(`dsh-bubble: stopped a running ${process}`)
    } catch {
      // Not running.
    }
  }
}

/** The insert row appended to the profile patch. */
const ROW = `# dsh-bubble: desktop floating ball (installed ${new Date().toISOString().slice(0, 10)})
- insert:
    - id: ${ROW_ID}
      name: ./plugins/${INSTALL_NAME}/src/host/index.js
      config:
        basePath: /dsh-bubble
        stateDir: ~/.dsh/dsh-bubble
        workspaceName: dsh_bubble
        frontPreset: standard
        autoStart: true
`

/**
 * Drop any previously installed insert block, including the pre-rename dsh-orb one.
 *
 * The banner comment above each block is dropped too: it is not part of the block itself, so leaving
 * it behind would accumulate one stale line per install.
 */
function stripExistingRow(text) {
  const ids = [ROW_ID, ...LEGACY_ROW_IDS]
  const banners = [ROW_ID, ...LEGACY_ROW_IDS].map((id) => `# ${id}:`)
  const blocks = []
  let current = []
  for (const line of text.split('\n')) {
    if (line.startsWith('- ') && current.length > 0) {
      blocks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  const kept = blocks
    .filter((block) => !block.some((line) => ids.some((id) => line.includes(`id: ${id}`))))
    .map((block) => block.filter((line) => !banners.some((banner) => line.startsWith(banner))))
  return kept.map((block) => block.join('\n')).join('\n').replace(/\n{3,}/gu, '\n\n')
}

/** Remove plugin directories left by an earlier name. */
async function removeLegacyPluginDirs() {
  for (const name of LEGACY_INSTALL_NAMES) {
    const stale = join(profileDir, 'plugins', name)
    if (!existsSync(stale)) continue
    await rm(stale, { recursive: true, force: true })
    console.log(`dsh-bubble: removed the pre-rename plugin directory ${stale}`)
  }
}

if (!existsSync(patchPath)) {
  console.error(`dsh-bubble: no profile patch at ${patchPath}`)
  process.exit(1)
}

const original = await readFile(patchPath, 'utf8')

if (remove) {
  await copyFile(patchPath, `${patchPath}.bak-before-${ROW_ID}-remove`)
  await writeFile(patchPath, `${stripExistingRow(original).trimEnd()}\n`, 'utf8')
  await rm(pluginDir, { recursive: true, force: true })
  await removeLegacyPluginDirs()
  console.log(`dsh-bubble: removed from ${profileDir}`)
  console.log('dsh-bubble: restart DSH Desktop to unload it')
  process.exit(0)
}

const stripped = stripExistingRow(original).trimEnd()
await copyFile(patchPath, `${patchPath}.bak-before-${ROW_ID}`)
await writeFile(patchPath, `${stripped}\n\n${ROW}`, 'utf8')

stopRunningShell()
await removeLegacyPluginDirs()
await mkdir(pluginDir, { recursive: true })
for (const entry of ENTRIES) {
  const from = join(PACKAGE_ROOT, entry)
  if (!existsSync(from)) continue
  const to = join(pluginDir, entry)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

console.log(`dsh-bubble: installed into ${profileDir}`)
console.log(`dsh-bubble: plugin files at ${pluginDir}`)
console.log(`dsh-bubble: backup at ${patchPath}.bak-before-${ROW_ID}`)
console.log('dsh-bubble: restart DSH Desktop to load the ball')
