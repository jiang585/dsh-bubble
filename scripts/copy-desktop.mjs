/**
 * Copy the built Tauri shell into the package's `desktop/dist/` directory.
 *
 * The plugin resolves the executable there first, so an installed package needs no Rust toolchain.
 *
 * @module dsh-bubble/scripts/copy-desktop
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(packageRoot, 'desktop', 'src-tauri', 'target', 'release', 'dsh-bubble-shell.exe')
const target = join(packageRoot, 'desktop', 'dist', 'dsh-bubble-shell.exe')

try {
  await stat(source)
} catch {
  console.error(`dsh-bubble: build the shell first; ${source} does not exist`)
  process.exit(1)
}

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`dsh-bubble: copied ${target}`)
