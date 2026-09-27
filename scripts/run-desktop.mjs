/**
 * Launch the desktop shell by hand, the same way the plugin launches it.
 *
 * The shell exits when its stdin closes, so this launcher keeps a pipe open for as long as it runs.
 * `node scripts/run-desktop.mjs [path-to-exe]`
 *
 * @module dsh-bubble/scripts/run-desktop
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = process.argv[2] ?? `${packageRoot}desktop/dist/dsh-bubble-shell.exe`

const child = spawn(executable, [], {
  env: {
    ...process.env,
    BUBBLE_API_BASE: process.env.BUBBLE_API_BASE ?? 'http://127.0.0.1:19387/dsh-bubble',
    BUBBLE_TOKEN: process.env.BUBBLE_TOKEN ?? 'dev-token',
    BUBBLE_LOCALE: process.env.BUBBLE_LOCALE ?? 'zh',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stdout.on('data', (chunk) => process.stdout.write(`[shell] ${chunk}`))
child.stderr.on('data', (chunk) => process.stderr.write(`[shell] ${chunk}`))
child.on('exit', (code, signal) => {
  console.log(`dsh-bubble shell exited (code ${code}, signal ${signal})`)
  process.exit(0)
})

console.log(`dsh-bubble shell started: ${executable}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill()
  })
}
