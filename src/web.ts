/**
 * Web route for the composer chip:
 * - `GET /ide-context/api/events?session=<id>`: server-sent events, one `data:`
 *   frame per distinct {@link ChipState}, pushed on IDE `selection_changed`,
 *   connection changes, and toggles (throttled to one frame per 50 ms).
 * - `GET /ide-context/api/state?session=<id>`: one-shot state (slow fallback).
 * - `POST /ide-context/api/toggle` with `{ session, enabled }`.
 * All read the single server-side IDE bridge; the browser never talks to the
 * IDE. The browser reads the stream with fetch() so the guard header applies.
 * @module dsh-auto-context/web (internal)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { computeChipState, type ChipState } from './chip.js'
import type { IdeBridge } from './bridge.js'
import type { SessionToggles } from './toggles.js'

/** Route prefix registered on the host web server. */
export const ROUTE_PREFIX = '/ide-context/api'

/** Header the client must send; forces a CORS preflight for cross-site callers. */
export const CLIENT_HEADER = 'x-dsh-ide-context'

/** Minimum spacing between pushed frames on one stream. */
export const PUSH_THROTTLE_MS = 50

/** SSE comment heartbeat, keeps proxies and the browser reader alive. */
export const HEARTBEAT_MS = 20_000

/** How often an open stream re-follows its session folder (lock rotation, cwd change). */
export const REFOLLOW_MS = 10_000

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Minimal view of a live session (header cwd + durable events). */
export interface SessionLike {
  readonly header: { readonly cwd?: string }
}

export interface WebDeps {
  bridge: Pick<IdeBridge, 'status' | 'latest' | 'followWorkspace'> & Partial<Pick<IdeBridge, 'onChange'>>
  toggles: SessionToggles
  /** Resolve a live session by id (undefined when unknown / not loaded). */
  getSession(id: string): SessionLike | undefined
  /** Stable state block of the session's latest injection, if any. */
  previousState(session: SessionLike): string | undefined
}

/** True for same-machine, same-origin requests carrying the client header. */
export function isAllowedRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!LOOPBACK.has(hostname)) return false
  // Browsers mark every fetch: only the dsh web page itself (same-origin) or a
  // direct navigation/tool (none / absent) may call; another localhost port is
  // 'same-site' and is refused too.
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  // A browser-sent Origin must be this very host.
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  } else if (origin === 'null') {
    return false
  }
  return req.headers[CLIENT_HEADER] === '1'
}

/** Compute the chip for one session (or for the bridge's current folder when the id is unknown). */
export function stateFor(deps: WebDeps, sessionId: string | undefined, options: { follow?: boolean } = {}): ChipState {
  const session = sessionId === undefined ? undefined : safeGet(deps, sessionId)
  const cwd = session?.header.cwd
  // Follow the same folder the next turn of this session would follow, so the
  // chip and the injection share one lock choice and the one connection.
  // Pushes triggered by bridge changes pass follow:false so a change can never
  // re-trigger a reselect (no feedback loop while a socket is still opening).
  if (cwd !== undefined && options.follow !== false) deps.bridge.followWorkspace(cwd)
  return computeChipState({
    enabled: deps.toggles.isEnabled(sessionId),
    bridge: deps.bridge.status(),
    snapshot: deps.bridge.latest(),
    previousState: session === undefined ? undefined : safePrevious(deps, session),
  })
}

function safeGet(deps: WebDeps, id: string): SessionLike | undefined {
  try {
    return deps.getSession(id)
  } catch {
    return undefined
  }
}

function safePrevious(deps: WebDeps, session: SessionLike): string | undefined {
  try {
    return deps.previousState(session)
  } catch {
    return undefined
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Serve one SSE stream. Every resource it takes (bridge listener, toggle
 * listener, timers) is released when the request or response closes.
 * @returns the disposer (also run automatically on close).
 */
export function openStream(
  deps: WebDeps,
  req: Pick<IncomingMessage, 'on'>,
  res: Pick<ServerResponse, 'writeHead' | 'write' | 'end' | 'on'> & { flushHeaders?: () => void },
  sessionId: string | undefined,
  counter?: { open: number },
): () => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()
  let closed = false
  let last = ''
  let lastPushAt = 0
  let pending: NodeJS.Timeout | undefined
  const push = (follow: boolean): void => {
    if (closed) return
    lastPushAt = Date.now()
    // Runs from timers and bridge callbacks: a throw here must never escape
    // into the host process.
    try {
      const json = JSON.stringify(stateFor(deps, sessionId, { follow }))
      if (json === last) return
      last = json
      res.write(`data: ${json}\n\n`)
    } catch {
      // Skip this frame; the next change or refollow tick retries.
    }
  }
  // Leading-edge throttle: push at once, then at most one frame per window.
  const schedule = (): void => {
    if (closed || pending !== undefined) return
    const wait = PUSH_THROTTLE_MS - (Date.now() - lastPushAt)
    if (wait <= 0) return push(false)
    pending = setTimeout(() => { pending = undefined; push(false) }, wait)
  }
  const offBridge = deps.bridge.onChange?.(schedule)
  const offToggles = deps.toggles.onChange((id) => { if (id === sessionId) schedule() })
  const heartbeat = setInterval(() => { if (!closed) res.write(': hb\n\n') }, HEARTBEAT_MS)
  const refollow = setInterval(() => { push(true) }, REFOLLOW_MS)
  if (counter !== undefined) counter.open++
  const dispose = (): void => {
    if (closed) return
    closed = true
    if (counter !== undefined) counter.open--
    offBridge?.()
    offToggles()
    clearInterval(heartbeat)
    clearInterval(refollow)
    if (pending !== undefined) clearTimeout(pending)
    try { res.end() } catch { /* already gone */ }
  }
  req.on('close', dispose)
  res.on('close', dispose)
  res.on('error', dispose)
  push(true)
  lastPushAt = 0 // the snapshot frame does not hold back the first change
  return dispose
}

/** Build the prefix-route handler; `handler.streams.open` counts live SSE streams. */
export function createHandler(deps: WebDeps) {
  const streams = { open: 0 }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isAllowedRequest(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://local')
      const method = url.pathname.slice(ROUTE_PREFIX.length)
      if (req.method === 'GET' && method === '/events') {
        const session = url.searchParams.get('session') ?? ''
        openStream(deps, req, res, session === '' ? undefined : session, streams)
        return
      }
      if (req.method === 'GET' && method === '/state') {
        const session = url.searchParams.get('session') ?? undefined
        return send(res, 200, { ok: true, value: stateFor(deps, session === '' ? undefined : session) })
      }
      if (req.method === 'POST' && method === '/toggle') {
        const parsed = JSON.parse(await readBody(req)) as { session?: unknown; enabled?: unknown }
        if (typeof parsed.session !== 'string' || parsed.session.length === 0 || typeof parsed.enabled !== 'boolean') {
          return send(res, 400, { ok: false, error: 'expected { session: string, enabled: boolean }' })
        }
        deps.toggles.set(parsed.session, parsed.enabled)
        return send(res, 200, { ok: true, value: stateFor(deps, parsed.session) })
      }
      return send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (res.headersSent) {
        try { res.end() } catch { /* already gone */ }
        return
      }
      return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return Object.assign(handler, { streams })
}
