/**
 * Parse and link every host module without a harness, then exercise the pure helpers.
 *
 * Run with the bundled Node: `node scripts/check-host.mjs`
 *
 * @module dsh-bubble/scripts/check-host
 */

import assert from 'node:assert/strict'
import { transcriptRows } from '../src/host/bubble.js'
import { resolveConfig } from '../src/host/config.js'

const entry = await import('../src/host/index.js')

assert.equal(entry.name, 'dsh-bubble')
assert.ok(Array.isArray(entry.inject), 'inject must be an array')
assert.equal(typeof entry.apply, 'function')
assert.equal(entry.default, undefined, 'a function plugin must not export a default')

const config = resolveConfig({ basePath: '/dsh-bubble', stateDir: '~/.dsh/dsh-bubble' })
assert.equal(config.basePath, '/dsh-bubble')
assert.equal(config.workspaceName, 'dsh_bubble')
assert.equal(config.frontPreset, 'standard')
assert.equal(config.autoStart, true)
assert.ok(config.stateDir.endsWith('dsh-bubble'), `stateDir resolved to ${config.stateDir}`)

assert.deepEqual(resolveConfig({ basePath: 'nope' }).basePath, '/dsh-bubble')
assert.deepEqual(resolveConfig(null).workspaceName, 'dsh_bubble')

const rows = transcriptRows([
  { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看这个项目' }] },
  { id: 's1', role: 'system', content: [{ type: 'text', text: 'ignored' }] },
  {
    id: 'catalog',
    role: 'user',
    source: { kind: 'skill-catalog', form: 'catalog' },
    content: [{ type: 'text', text: '<system-reminder>available_skills</system-reminder>' }],
  },
  {
    id: 'a1',
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'text', text: '我来看一下。' },
    ],
  },
  { id: 't1', role: 'tool', content: [{ type: 'text', text: 'README.md\nsrc' }] },
])

assert.equal(rows.length, 4, `expected 4 rows, got ${JSON.stringify(rows)}`)
assert.deepEqual(rows[0], { id: 'u1', role: 'user', text: '帮我看看这个项目' })
assert.equal(rows[1].role, 'tool')
assert.equal(rows[1].name, 'bash')
assert.equal(rows[1].summary, '{"command":"ls"}')
assert.equal(rows[2].role, 'assistant')
assert.equal(rows[3].role, 'tool')
assert.equal(rows[3].name, '工具结果')
assert.equal(rows[3].summary, 'README.md')

console.log('dsh-bubble host modules: ok')
