/**
 * Composer-chip state: a pure projection of what the next eligible turn would
 * inject, shared by the web route and the tests. No I/O here.
 * @module @deepseek-ai/dsh-ide-context/chip (internal)
 */

import { MAX_SELECTION_TEXT_CHARS } from './constants.js'
import { renderState } from './format.js'
import type { IdeSnapshot } from './types.js'

/** Bridge-side connection facts the chip needs. */
export interface BridgeStatus {
  /** A lock file was found for the followed workspace. */
  lockFound: boolean
  /** The single MCP WebSocket to the IDE is open. */
  connected: boolean
  ideName: string | undefined
  workspaceFolders: string[]
}

/** What the composer chip shows. */
export interface ChipState {
  /** Per-session "include IDE context" switch (true = inject as usual). */
  enabled: boolean
  /** `disconnected`: no lock / socket for this folder; `no-selection`: connected, nothing selected. */
  status: 'disconnected' | 'no-selection' | 'selection'
  ideName?: string
  /** Absolute path of the selected file. */
  filePath?: string
  /** `basename:start-end` (1-based, inclusive). */
  label?: string
  startLine?: number
  endLine?: number
  /**
   * Selected line count as Claude Code shows it: end - start + 1, minus the last
   * line when the selection ends at column 0 of it.
   */
  lineCount?: number
  /** Selected characters (before the injection cap). */
  chars?: number
  /** True when the selection exceeds the injection cap and will be truncated. */
  truncated?: boolean
  /**
   * True when the next turn would inject (state differs from the last injection
   * in this session); false when the same state was already sent.
   */
  pending?: boolean
}

/** Last path segment, separator-agnostic. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part.length > 0)
  return parts.length === 0 ? path : parts[parts.length - 1] ?? path
}

/**
 * True when the snapshot holds selected text. A bare caret (no text) counts as
 * "nothing selected" for the chip, like Claude Code's own indicator.
 */
function hasSelection(snapshot: IdeSnapshot | undefined): snapshot is IdeSnapshot & { selection: NonNullable<IdeSnapshot['selection']> } {
  const selection = snapshot?.selection
  return selection !== undefined && selection.text.length > 0
}

/** Claude Code's line count: a selection ending at column 0 does not count that last line. */
export function selectedLineCount(start: { line: number; character: number }, end: { line: number; character: number }): number {
  const count = end.line - start.line + 1
  return end.character === 0 && end.line > start.line ? count - 1 : count
}

/**
 * Project the bridge state into the chip.
 * @param input.previousState - stable state block of the session's latest injection, if any.
 */
export function computeChipState(input: {
  enabled: boolean
  bridge: BridgeStatus
  snapshot: IdeSnapshot | undefined
  previousState: string | undefined
}): ChipState {
  const { enabled, bridge, snapshot, previousState } = input
  const ideName = bridge.ideName ?? snapshot?.ideName
  const base: ChipState = { enabled, status: 'disconnected', ...(ideName !== undefined ? { ideName } : {}) }
  if (!bridge.lockFound || !bridge.connected) return base
  const state = snapshot === undefined ? '' : renderState(snapshot)
  const pending = state.length > 0 && state !== previousState
  if (!hasSelection(snapshot)) return { ...base, status: 'no-selection', pending }
  const { selection } = snapshot
  const lineCount = selectedLineCount(selection.start, selection.end)
  const startLine = selection.start.line + 1
  // Display range matches the count (a trailing column-0 line is not shown).
  const endLine = startLine + lineCount - 1
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
  return {
    ...base,
    status: 'selection',
    filePath: selection.filePath,
    label: `${baseName(selection.filePath)}:${range}`,
    startLine,
    endLine,
    lineCount,
    chars: selection.text.length,
    truncated: selection.text.length > MAX_SELECTION_TEXT_CHARS,
    pending,
  }
}
