// Pure-logic tests for the composer chip (node:test; run against the built index.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { computeChipState, baseName, selectedLineCount, renderState, SessionToggles, isAllowedRequest, stateFor } from '../index.js'

const connected = { lockFound: true, connected: true, ideName: 'Visual Studio Code', workspaceFolders: ['/w'] }
const sel = (text, sl = 16, el = 19) => ({ filePath: '/w/docs/products-with-claude.md', start: { line: sl, character: 0 }, end: { line: el, character: 3 }, text })
const snap = (selection, openedFiles = ['/w/docs/products-with-claude.md']) => ({ ideName: 'Visual Studio Code', workspaceFolders: ['/w'], openedFiles, ...(selection ? { selection } : {}) })

test('baseName handles posix and windows separators', () => {
  assert.equal(baseName('/a/b/c.md'), 'c.md')
  assert.equal(baseName('C:\\x\\y.ts'), 'y.ts')
})

test('disconnected when no lock or socket', () => {
  for (const bridge of [{ ...connected, lockFound: false }, { ...connected, connected: false }]) {
    const s = computeChipState({ enabled: true, bridge, snapshot: snap(sel('x')), previousState: undefined })
    assert.equal(s.status, 'disconnected')
    assert.equal(s.label, undefined)
  }
})

test('selection: 1-based range, Claude line count, pending until sent', () => {
  const snapshot = snap(sel('abc'))
  const s = computeChipState({ enabled: true, bridge: connected, snapshot, previousState: undefined })
  assert.equal(s.status, 'selection')
  assert.equal(s.label, 'products-with-claude.md:17-20')
  assert.equal(s.lineCount, 4)
  assert.equal(s.filePath, '/w/docs/products-with-claude.md')
  assert.equal(s.pending, true)
  const again = computeChipState({ enabled: true, bridge: connected, snapshot, previousState: renderState(snapshot) })
  assert.equal(again.pending, false)
})

test('selectedLineCount drops a trailing column-0 line like Claude Code', () => {
  assert.equal(selectedLineCount({ line: 4, character: 2 }, { line: 4, character: 9 }), 1)
  assert.equal(selectedLineCount({ line: 4, character: 0 }, { line: 7, character: 3 }), 4)
  assert.equal(selectedLineCount({ line: 4, character: 0 }, { line: 7, character: 0 }), 3)
  const s = computeChipState({ enabled: true, bridge: connected, snapshot: snap({ filePath: '/w/a.md', start: { line: 4, character: 0 }, end: { line: 7, character: 0 }, text: 'x\ny\nz\n' }), previousState: undefined })
  assert.equal(s.label, 'a.md:5-7')
  assert.equal(s.lineCount, 3)
})

test('single-line label and truncation flag', () => {
  const s = computeChipState({ enabled: true, bridge: connected, snapshot: snap(sel('y'.repeat(9000), 4, 4)), previousState: undefined })
  assert.equal(s.label, 'products-with-claude.md:5')
  assert.equal(s.truncated, true)
})

test('a caret without text is no-selection', () => {
  const caret = computeChipState({ enabled: true, bridge: connected, snapshot: snap({ filePath: '/w/a.md', start: { line: 7, character: 2 }, end: { line: 7, character: 2 }, text: '' }), previousState: undefined })
  assert.equal(caret.status, 'no-selection')
  assert.equal(caret.pending, true) // opened files / caret still change-inject server-side
})

test('enabled flag is carried through regardless of status', () => {
  const s = computeChipState({ enabled: false, bridge: { ...connected, connected: false }, snapshot: undefined, previousState: undefined })
  assert.equal(s.enabled, false)
})

test('SessionToggles persists off sessions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ic-')), 'sub', 'sessions.json')
  const t = new SessionToggles(file)
  assert.equal(t.isEnabled('s1'), true)
  t.set('s1', false)
  assert.equal(new SessionToggles(file).isEnabled('s1'), false)
  t.set('s1', true)
  assert.equal(new SessionToggles(file).isEnabled('s1'), true)
  assert.equal(t.isEnabled(undefined), true)
})

test('route guard: loopback host + client header, not cross-site', () => {
  const ok = { host: '127.0.0.1:3080', 'x-dsh-ide-context': '1' }
  assert.equal(isAllowedRequest({ headers: ok }), true)
  assert.equal(isAllowedRequest({ headers: { ...ok, host: 'localhost:51234' } }), true)
  assert.equal(isAllowedRequest({ headers: { ...ok, host: 'evil.example:3080' } }), false)
  assert.equal(isAllowedRequest({ headers: { host: '127.0.0.1:3080' } }), false)
  assert.equal(isAllowedRequest({ headers: { ...ok, 'sec-fetch-site': 'cross-site' } }), false)
})

test('stateFor follows the session cwd and never opens its own connection', () => {
  const followed = []
  const deps = {
    bridge: { status: () => connected, latest: () => snap(sel('abc')), followWorkspace: (cwd) => followed.push(cwd) },
    toggles: new SessionToggles(undefined),
    getSession: (id) => (id === 's1' ? { header: { cwd: '/w' } } : undefined),
    previousState: () => undefined,
  }
  assert.equal(stateFor(deps, 's1').label, 'products-with-claude.md:17-20')
  assert.deepEqual(followed, ['/w'])
  stateFor(deps, 'unknown')
  assert.deepEqual(followed, ['/w'])
})

test('client view model wording (Claude-style)', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { mod = factory((n) => (n === 'react' ? { createElement() {} } : {})) } } } }
  vm.runInNewContext(src, sandbox)
  assert.equal(mod.view(null, true), null)
  assert.equal(mod.view({ enabled: false, status: 'no-selection' }, true).text, 'IDE context off')
  assert.equal(mod.view({ enabled: true, status: 'disconnected' }, true).text, 'IDE not connected')
  assert.equal(mod.view({ enabled: true, status: 'no-selection' }, true), null)
  const base = { enabled: true, status: 'selection', label: 'a.md:17-20', filePath: '/w/a.md', startLine: 17, endLine: 20, lineCount: 4, pending: true }
  const on = mod.view(base, true)
  assert.equal(on.text, '4 lines selected')
  assert.match(on.title, /a\.md:17-20/)
  assert.match(on.title, /\/w\/a\.md/)
  assert.equal(mod.view({ ...base, startLine: 3, endLine: 3, lineCount: 1 }, true).text, '1 line selected')
  assert.equal(mod.view({ ...base, pending: false }, true).tone, 'sent')
})
