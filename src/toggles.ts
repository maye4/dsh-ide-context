/**
 * Per-session "include IDE context" switch, persisted best-effort to a small
 * JSON file so a dsh restart keeps a session's choice. Only "off" sessions are
 * stored; the default is on.
 * @module @deepseek-ai/dsh-ide-context/toggles (internal)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Upper bound on remembered "off" sessions (oldest dropped first). */
export const MAX_REMEMBERED_SESSIONS = 500

export class SessionToggles {
  private readonly disabled: string[]
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(private readonly file: string | undefined) {
    this.disabled = []
    if (file === undefined) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { disabled?: unknown }
      if (Array.isArray(parsed.disabled)) {
        for (const id of parsed.disabled) if (typeof id === 'string') this.disabled.push(id)
      }
    } catch {
      // Missing or unreadable file: start with everything on.
    }
  }

  /** True unless the session was switched off. */
  isEnabled(sessionId: string | undefined): boolean {
    return sessionId === undefined || !this.disabled.includes(sessionId)
  }

  /** Subscribe to switch flips; returns the disposer. */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Switch one session on/off; returns the new enabled value. */
  set(sessionId: string, enabled: boolean): boolean {
    const index = this.disabled.indexOf(sessionId)
    if (enabled && index !== -1) this.disabled.splice(index, 1)
    if (!enabled && index === -1) {
      this.disabled.push(sessionId)
      while (this.disabled.length > MAX_REMEMBERED_SESSIONS) this.disabled.shift()
    }
    this.save()
    for (const listener of [...this.listeners]) {
      try { listener(sessionId) } catch { /* ignore */ }
    }
    return enabled
  }

  private save(): void {
    if (this.file === undefined) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ disabled: this.disabled }, null, 2), 'utf8')
    } catch {
      // Best-effort: keep the in-memory value.
    }
  }
}
