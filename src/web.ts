/**
 * Web route for the composer chip: `GET /ide-context/api/state?session=<id>`
 * returns {@link ChipState}; `POST /ide-context/api/toggle` with
 * `{ session, enabled }` flips the per-session switch. Both read the single
 * server-side IDE bridge; the browser never talks to the IDE.
 * @module @deepseek-ai/dsh-ide-context/web (internal)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { computeChipState, type ChipState } from './chip.js'
import type { IdeBridge } from './bridge.js'
import type { SessionToggles } from './toggles.js'

/** Route prefix registered on the host web server. */
export const ROUTE_PREFIX = '/ide-context/api'

/** Header the client must send; forces a CORS preflight for cross-site callers. */
export const CLIENT_HEADER = 'x-dsh-ide-context'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Minimal view of a live session (header cwd + durable events). */
export interface SessionLike {
  readonly header: { readonly cwd?: string }
}

export interface WebDeps {
  bridge: Pick<IdeBridge, 'status' | 'latest' | 'followWorkspace'>
  toggles: SessionToggles
  /** Resolve a live session by id (undefined when unknown / not loaded). */
  getSession(id: string): SessionLike | undefined
  /** Stable state block of the session's latest injection, if any. */
  previousState(session: SessionLike): string | undefined
}

/** True for same-machine browser requests carrying the client header. */
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
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return req.headers[CLIENT_HEADER] === '1'
}

/** Compute the chip for one session (or for the bridge's current folder when the id is unknown). */
export function stateFor(deps: WebDeps, sessionId: string | undefined): ChipState {
  const session = sessionId === undefined ? undefined : safeGet(deps, sessionId)
  const cwd = session?.header.cwd
  // Follow the same folder the next turn of this session would follow, so the
  // chip and the injection share one lock choice and the one connection.
  if (cwd !== undefined) deps.bridge.followWorkspace(cwd)
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

/** Build the prefix-route handler. */
export function createHandler(deps: WebDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isAllowedRequest(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://local')
      const method = url.pathname.slice(ROUTE_PREFIX.length)
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
      return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
