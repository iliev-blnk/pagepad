import type { Controls } from '../types'

export type { Control, Controls } from '../types'

export interface PadSnapshot {
  state: Record<string, unknown> | null
  controls: Controls | null
}

export interface Pad {
  send(action: string, value?: unknown): Promise<void>
  onState(fn: (snapshot: PadSnapshot) => void): () => void
  /** Called once when the host's session no longer exists. */
  onEnd(fn: () => void): () => void
  close(): void
}

export interface ConnectOptions {
  fetch?: typeof fetch
  /** How often to read host state. Default 1000 ms. */
  pollMs?: number
}

/** Connect to a host from its pair URL (`<endpoint>?s=<id>#<secret>`). */
export function connect(pairUrl: string, options: ConnectOptions = {}): Pad {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const pollMs = options.pollMs ?? 1000
  const url = new URL(pairUrl)
  const id = url.searchParams.get('s') ?? ''
  const secret = url.hash.slice(1)
  const endpoint = url.origin + url.pathname

  const stateFns = new Set<(s: PadSnapshot) => void>()
  const endFns = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function end() {
    if (stopped) return
    stop()
    for (const fn of endFns) fn()
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }

  async function tick() {
    clearTimeout(timer)
    try {
      const res = await doFetch(`${endpoint}?op=state&id=${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${secret}` },
      })
      if (res.status === 404) return end()
      if (res.ok) {
        const { state, controls } = (await res.json()) as PadSnapshot
        if (!stopped) for (const fn of stateFns) fn({ state, controls })
      }
    } catch {
      // Network blip: try again on the next tick.
    }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }

  function onVisible() {
    if (document.visibilityState === 'visible' && !stopped) void tick()
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  void tick()

  return {
    async send(action, value = null) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'cmd', id, secret, action, value }),
      })
      if (res.status === 404) return end()
      if (!res.ok) throw new Error(`[pagepad] relay answered ${res.status}`)
    },
    onState(fn) {
      stateFns.add(fn)
      return () => void stateFns.delete(fn)
    },
    onEnd(fn) {
      endFns.add(fn)
      return () => void endFns.delete(fn)
    },
    close: stop,
  }
}
