/**
 * IDE-context plugin: assembles the background IDE bridge (WebSocket + MCP),
 * the lock-file workspace selection, and the change-suppressed per-turn
 * injection. This entry re-exports the full public API so the package surface
 * is unchanged; the implementation is organized into focused modules:
 *
 * - {@link ./types.js}     domain model + configuration
 * - {@link ./constants.js} shared names and tunables
 * - {@link ./platform.js}  path/URI handling (POSIX now, Windows seam in place)
 * - {@link ./lock.js}      lock-file discovery and workspace selection
 * - {@link ./ws.js}        zero-dependency RFC 6455 WebSocket client
 * - {@link ./protocol.js}  MCP tool-result parsing
 * - {@link ./bridge.js}    connection lifecycle + snapshot maintenance
 * - {@link ./format.js}    snapshot rendering (pluggable selection strategy)
 *
 * @module dsh-auto-context
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DATA_READY_TIMEOUT_MS,
  DEFAULT_LOCK_DIR,
  name,
} from './constants.js'
import { IdeBridge } from './bridge.js'
import { renderReading, renderState } from './format.js'
import { validatePositiveInteger, type Config, type IdeSnapshot } from './types.js'
import { SessionToggles } from './toggles.js'
import { createHandler, ROUTE_PREFIX, type SessionLike } from './web.js'

// ---------------------------------------------------------------------------
// Public API — the package surface is unchanged; implementation moves below.
// ---------------------------------------------------------------------------

// Domain model (types + config schema).
export { Config } from './types.js'
export type { IdePosition, IdeSelection, IdeSnapshot } from './types.js'

// Plugin identity.
export { name, inject } from './constants.js'

// Lock-file discovery and workspace selection.
export { scanLocks, scanLatestLock, selectLockByWorkspace, filterFilesUnderRoots } from './lock.js'

// Bridge.
export { IdeBridge } from './bridge.js'

// Protocol parsing.
export { extractOpenedFiles, extractSelectionToolResult } from './protocol.js'

// Rendering.
export { renderState } from './format.js'

// Composer chip (pure state + per-session switch + route).
export { computeChipState, baseName, selectedLineCount } from './chip.js'
export type { ChipState, BridgeStatus } from './chip.js'
export { SessionToggles } from './toggles.js'
export { createHandler, openStream, isAllowedRequest, stateFor, ROUTE_PREFIX, CLIENT_HEADER, PUSH_THROTTLE_MS } from './web.js'

/** The slice of a durable session event this module reads. */
interface SessionEventLike {
  type: string
  time: number
  data: { source: { kind: string }; content: ReadonlyArray<{ type: string; text: string }> }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The active IDE bridge; provided by this plugin unless a test replaces it. */
    ideContext?: IdeBridge
  }
}

/**
 * The stable state block of this plugin's latest durable injection, or
 * `undefined` when the session has none. Scans raw durable events so the
 * schedule survives compaction and resumed processes without process-local
 * cache state.
 */
function latestInjectedState(agent: Agent): { state: string; time: number } | undefined {
  return latestInjectedStateOf(agent.session)
}

/** {@link latestInjectedState} for any session object exposing `snapshotEvents()`. */
function latestInjectedStateOf(session: unknown): { state: string; time: number } | undefined {
  const events = (session as { snapshotEvents?: () => readonly SessionEventLike[] }).snapshotEvents?.() ?? []
  for (const event of [...events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === name) {
      const [block] = event.data.content
      if (block?.type !== 'text') return undefined
      const newline = block.text.indexOf('\n')
      const state = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state, time: event.time }
    }
  }
  return undefined
}

/**
 * Read the latest snapshot, waiting briefly for the first poll when the bridge
 * supports it. Tests inject a minimal stub without `awaitLatest`, so fall back
 * to the synchronous read in that case.
 */
async function readSnapshot(bridge: IdeBridge, timeoutMs: number): Promise<IdeSnapshot | undefined> {
  if (typeof bridge.awaitLatest === 'function') return await bridge.awaitLatest(timeoutMs)
  return bridge.latest()
}

/**
 * Register a prepended pre-step listener plus the background IDE bridge for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the listener and bridge are disposed with it.
 * @param config - scheduling and bridge tuning.
 */
export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  const pollIntervalMs = config.pollIntervalMs ?? 5_000
  const lockDir = config.lockDir ?? DEFAULT_LOCK_DIR
  const toggles = new SessionToggles(join(homedir(), '.dsh', 'ide-context', 'sessions.json'))
  validatePositiveInteger(refreshIntervalMs, 'refreshIntervalMs')
  validatePositiveInteger(pollIntervalMs, 'pollIntervalMs')

  const bridge = ctx.get('ideContext') ?? new IdeBridge(lockDir, pollIntervalMs, ctx.logger)
  if (ctx.get('ideContext') === undefined) {
    ctx.provide('ideContext', bridge)
    ctx.effect(() => {
      bridge.start()
      return () => { bridge.dispose() }
    }, `${name} bridge`)
  }

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    // Composer chip switched this session off: skip the reading entirely.
    if (!toggles.isEnabled(agent.session.id)) return decision
    bridge.followWorkspace(agent.session.header.cwd)
    const previous = latestInjectedState(agent)
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== undefined) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const snapshot = await readSnapshot(bridge, DATA_READY_TIMEOUT_MS)
    if (snapshot === undefined) return decision
    const state = renderState(snapshot)
    if (state.length === 0) return decision
    if (previous !== undefined && previous.state === state) return decision
    const text = renderReading(snapshot, turn)
    return {
      kind: 'enter',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })

  // Composer chip route. Optional: profiles without a web server (headless,
  // tui) simply skip it.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createHandler({
      bridge,
      toggles,
      getSession: (id) => {
        const sessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as
          { get(id: string): SessionLike | undefined } | undefined
        return sessions?.get(id)
      },
      previousState: (session) => latestInjectedStateOf(session)?.state,
    })
    webCtx.effect(() => (webCtx as unknown as {
      webServer: { register(route: { kind: 'prefix'; path: string; handler: typeof handler }): () => void }
    }).webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), `${name} chip route`)
  })
}
