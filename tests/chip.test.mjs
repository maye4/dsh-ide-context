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
  assert.equal(isAllowedRequest({ headers: { ...ok, 'sec-fetch-site': 'same-site' } }), false, 'another localhost port')
  assert.equal(isAllowedRequest({ headers: { ...ok, 'sec-fetch-site': 'same-origin', origin: `http://${ok.host}` } }), true)
  assert.equal(isAllowedRequest({ headers: { ...ok, origin: 'http://localhost:5173' } }), false, 'foreign origin')
  assert.equal(isAllowedRequest({ headers: { ...ok, origin: 'null' } }), false, 'opaque origin')
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

// --- push channel ---------------------------------------------------------
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { openStream, createHandler, PUSH_THROTTLE_MS } from '../index.js'

function fakeBridge(initial) {
  const listeners = new Set()
  let snapshot = initial
  return {
    listeners,
    status: () => connected,
    latest: () => snapshot,
    followWorkspace: () => {},
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l) },
    set(next) { snapshot = next; for (const l of [...listeners]) l() },
  }
}
const frames = (writes) => writes.filter(w => w.startsWith('data: ')).map(w => JSON.parse(w.slice(6)))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('openStream: initial frame, immediate push, throttle, dedupe, toggle, full cleanup', async () => {
  const bridge = fakeBridge(snap(sel('a', 0, 0)))
  const toggles = new SessionToggles(undefined)
  const deps = { bridge, toggles, getSession: () => ({ header: { cwd: '/w' } }), previousState: () => undefined }
  const req = new EventEmitter(); const res = new EventEmitter(); const writes = []
  Object.assign(res, { writeHead() {}, write: (c) => { writes.push(c); return true }, end() {} })
  const counter = { open: 0 }
  openStream(deps, req, res, 's1', counter)
  assert.equal(counter.open, 1)
  assert.equal(frames(writes).length, 1)
  assert.equal(frames(writes)[0].lineCount, 1)
  await sleep(PUSH_THROTTLE_MS + 5)
  bridge.set(snap(sel('ab', 0, 1)))           // leading edge: immediate
  assert.equal(frames(writes).length, 2)
  bridge.set(snap(sel('abc', 0, 2)))          // inside window: deferred
  bridge.set(snap(sel('abcd', 0, 3)))         // coalesced
  assert.equal(frames(writes).length, 2)
  await sleep(PUSH_THROTTLE_MS + 10)
  assert.equal(frames(writes).length, 3)
  assert.equal(frames(writes)[2].lineCount, 4)
  await sleep(PUSH_THROTTLE_MS + 5)
  bridge.set(snap(sel('abcd', 0, 3)))         // unchanged state: no frame
  await sleep(PUSH_THROTTLE_MS + 10)
  assert.equal(frames(writes).length, 3)
  toggles.set('other', false)                 // other session: no frame
  await sleep(PUSH_THROTTLE_MS + 10)
  assert.equal(frames(writes).length, 3)
  toggles.set('s1', false)
  await sleep(PUSH_THROTTLE_MS + 10)
  assert.equal(frames(writes).at(-1).enabled, false)
  req.emit('close'); res.emit('close')
  assert.equal(counter.open, 0)
  assert.equal(bridge.listeners.size, 0)
  const n = writes.length
  bridge.set(snap(sel('zz', 5, 9))); toggles.set('s1', true)
  await sleep(PUSH_THROTTLE_MS + 10)
  assert.equal(writes.length, n)              // nothing after close
})

test('HTTP /events: streams frames over a real socket and releases everything on abort', async () => {
  const bridge = fakeBridge(snap(sel('a', 2, 2)))
  const handler = createHandler({ bridge, toggles: new SessionToggles(undefined), getSession: () => undefined, previousState: () => undefined })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const forbidden = await fetch(`http://127.0.0.1:${port}/ide-context/api/events`)
    assert.equal(forbidden.status, 403)
    await forbidden.body?.cancel()
    const ac = new AbortController()
    const r = await fetch(`http://127.0.0.1:${port}/ide-context/api/events?session=s1`, { headers: { 'x-dsh-ide-context': '1' }, signal: ac.signal })
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''
    const next = async () => { for (;;) { const i = buf.indexOf('\n\n'); if (i !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith('data: ')) return JSON.parse(f.slice(6)) } const c = await reader.read(); buf += dec.decode(c.value, { stream: true }) } }
    assert.equal((await next()).label, 'products-with-claude.md:3')
    assert.equal(handler.streams.open, 1)
    assert.equal(bridge.listeners.size, 1)
    const t0 = performance.now(); bridge.set(snap(sel('abc', 2, 4)))
    const pushed = await next()
    assert.equal(pushed.lineCount, 3)
    assert.ok(performance.now() - t0 < 40, 'server push should be immediate')
    ac.abort()
    for (let i = 0; i < 50 && handler.streams.open > 0; i++) await sleep(10)
    assert.equal(handler.streams.open, 0)
    assert.equal(bridge.listeners.size, 0)
  } finally {
    server.closeAllConnections?.(); server.close()
  }
})

test('openStream: a failing state read never throws out of the stream (timers / bridge callbacks)', async () => {
  const bridge = fakeBridge(snap(sel('a', 0, 0)))
  let fail = true
  const deps = { bridge: { ...bridge, status: () => { if (fail) throw new Error('boom'); return bridge.status() } }, toggles: new SessionToggles(undefined), getSession: () => undefined, previousState: () => undefined }
  const req = new EventEmitter(); const res = new EventEmitter(); const writes = []
  Object.assign(res, { writeHead() {}, write: (c) => { writes.push(c); return true }, end() {} })
  const dispose = openStream(deps, req, res, 's1')
  assert.equal(frames(writes).length, 0)
  assert.doesNotThrow(() => bridge.set(snap(sel('ab', 0, 1))))
  fail = false
  await sleep(PUSH_THROTTLE_MS + 5)
  bridge.set(snap(sel('abc', 0, 2)))
  assert.equal(frames(writes).length, 1, 'recovers on the next change')
  dispose()
  assert.equal(bridge.listeners.size, 0)
})
