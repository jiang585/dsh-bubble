/**
 * Copy the built Tauri shell into the package's `desktop/dist/` directory.
 *
 * The plugin resolves the executable there first, so an installed package needs no Rust toolchain.
 *
 * `tauri.conf.json` embeds `web/` into the executable at build time, so a shell built before the last
 * panel edit serves a stale UI while every file on disk still looks current. That combination has
 * shipped a "fixed" panel that was not actually fixed, so the copy refuses to proceed unless the
 * executable is newer than the panel and shell sources. Pass `--force` to copy anyway.
 *
 * @module dsh-bubble/scripts/copy-desktop
 */

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(packageRoot, 'desktop', 'src-tauri', 'target', 'release', 'dsh-bubble-shell.exe')
const target = join(packageRoot, 'desktop', 'dist', 'dsh-bubble-shell.exe')

/** Directories whose contents are compiled or embedded into the executable. */
const embeddedSources = [join(packageRoot, 'web'), join(packageRoot, 'desktop', 'src-tauri', 'src')]

/**
 * Newest modification time under a directory, ignoring generated trees.
 *
 * @param directory - Directory to scan.
 * @returns Highest `mtimeMs`, or 0 when nothing was found.
 */
async function newestMtime(directory) {
  let newest = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name.endsWith('.log')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(path))
      continue
    }
    const info = await stat(path)
    newest = Math.max(newest, info.mtimeMs)
  }
  return newest
}

let shell
try {
  shell = await stat(source)
} catch {
  console.error(`dsh-bubble: build the shell first; ${source} does not exist`)
  process.exit(1)
}

const force = process.argv.includes('--force')
let newestSource = 0
let newestPath = ''
for (const directory of embeddedSources) {
  const mtime = await newestMtime(directory)
  if (mtime > newestSource) {
    newestSource = mtime
    newestPath = directory
  }
}

if (!force && newestSource > shell.mtimeMs) {
  const stale = ((newestSource - shell.mtimeMs) / 1000).toFixed(0)
  console.error('dsh-bubble: the shell executable is older than the assets it embeds')
  console.error(`  executable : ${new Date(shell.mtimeMs).toISOString()}`)
  console.error(`  newest src : ${new Date(newestSource).toISOString()}  (${newestPath}, +${stale}s)`)
  console.error('  The panel is compiled into the executable, so this copy would ship a stale UI.')
  console.error('  Rebuild first:  cargo build --release --manifest-path desktop/src-tauri/Cargo.toml')
  console.error('  Or copy anyway: node scripts/copy-desktop.mjs --force')
  process.exit(1)
}

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`dsh-bubble: copied ${target}`)
