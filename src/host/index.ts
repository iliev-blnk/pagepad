import type { Command, Controls } from '../types'
import { renderOverlay } from './qr'

export type { Control, Controls } from '../types'

export interface HostOptions {
  /** Relay URL. Relative URLs resolve against the current page. */
  endpoint: string
  fetch?: typeof fetch
  /** Seconds the relay may hold one poll open. Default 25. */
  pollWaitSec?: number
}

export interface Host {
  /** Declare the phone UI. Keys are action names. */
  controls(controls: Controls): void
  /** Handle one action, or every action with `'*'`. Returns an unsubscribe function. */
  on(action: string, fn: (value: unknown) => void): () => void
  on(action: '*', fn: (action: string, value: unknown) => void): () => void
  /** Shallow-merge into the state shown on the phone. */
  setState(patch: Record<string, unknown>): void
  showQR(): void
  hideQR(): void
  /** URL that pairs a phone with this page. Changes if the session has to be renewed. */
  readonly pairUrl: string
  /** Called with the new `pairUrl` when the session is renewed. Returns an unsubscribe function. */
  onPairUrl(fn: (url: string) => void): () => void
  close(): void
}

interface Credentials {
  id: string
  hostToken: string
  secret: string
}

interface Batch {
  seq: number
  reset: boolean
  cmds: Command[]
}

const BATCH_MS = 250
const HEARTBEAT_MS = 10_000
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 15_000

class SessionGone extends Error {}

export async function createHost(options: HostOptions): Promise<Host> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const pollWaitSec = options.pollWaitSec ?? 25
  const endpoint = new URL(
    options.endpoint,
    typeof location === 'undefined' ? undefined : location.href,
  )

  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let state: Record<string, unknown> = {}
  let declared: Controls | undefined
  let since = 0
  let closed = false
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  let overlay: HTMLElement | undefined
  const abort = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()

  async function post(body: Record<string, unknown>) {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
    if (res.status === 404) throw new SessionGone()
    if (!res.ok) throw new Error(`[pagepad] relay answered ${res.status}`)
    return res.json()
  }

  const createSession = async () => (await post({ op: 'create' })) as Credentials

  let creds = await createSession()

  const pairUrl = () => {
    const url = new URL(endpoint)
    url.searchParams.set('s', creds.id)
    url.hash = creds.secret
    return url.toString()
  }

  function emit(action: string, value: unknown) {
    const call = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        console.error('[pagepad] handler failed', err)
      }
    }
    for (const fn of handlers.get(action) ?? []) call(() => fn(value))
    for (const fn of handlers.get('*') ?? []) call(() => fn(action, value))
  }

  function dispatch(batch: Batch) {
    for (const cmd of batch.cmds) {
      if (batch.reset || cmd.id > since) emit(cmd.action, cmd.value)
    }
    since = batch.reset ? batch.seq : Math.max(since, batch.seq)
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t)
        resolve()
      }, ms)
      timers.add(t)
    })

  const pairFns = new Set<(url: string) => void>()

  async function renew() {
    creds = await createSession()
    since = 0
    if (overlay) {
      hideQR()
      showQR()
    }
    for (const fn of pairFns) fn(pairUrl())
    void sendState()
  }

  async function sendState() {
    if (closed) return
    try {
      const body: Record<string, unknown> = {
        op: 'state',
        id: creds.id,
        hostToken: creds.hostToken,
        state,
        since,
      }
      if (declared) body.controls = declared
      dispatch((await post(body)) as Batch)
    } catch (err) {
      // The poll loop owns recovery; the heartbeat retries the state.
      if (!closed && !(err instanceof SessionGone)) console.warn('[pagepad] state not sent', err)
    }
  }

  function scheduleState() {
    if (batchTimer || closed) return
    batchTimer = setTimeout(() => {
      batchTimer = undefined
      void sendState()
    }, BATCH_MS)
  }

  async function pollLoop() {
    let failures = 0
    while (!closed) {
      try {
        const url = new URL(endpoint)
        url.searchParams.set('op', 'poll')
        url.searchParams.set('id', creds.id)
        url.searchParams.set('since', String(since))
        url.searchParams.set('wait', String(pollWaitSec))
        const res = await doFetch(url, {
          headers: { authorization: `Bearer ${creds.hostToken}` },
          signal: abort.signal,
        })
        if (res.status === 404) throw new SessionGone()
        if (!res.ok) throw new Error(`[pagepad] relay answered ${res.status}`)
        dispatch((await res.json()) as Batch)
        failures = 0
      } catch (err) {
        if (closed) return
        if (err instanceof SessionGone) {
          try {
            await renew()
            failures = 0
            continue
          } catch {}
        }
        await wait(Math.min(BACKOFF_START_MS * 2 ** failures, BACKOFF_MAX_MS))
        failures++
      }
    }
  }

  const heartbeat = setInterval(() => void sendState(), HEARTBEAT_MS)

  // Tell the relay the page is gone so the phone shows "session ended" at once.
  // keepalive lets the request outlive the page.
  function endSession() {
    void doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'end', id: creds.id, hostToken: creds.hostToken }),
      keepalive: true,
    }).catch(() => {})
  }

  if (typeof addEventListener === 'function') addEventListener('pagehide', endSession)

  function showQR() {
    if (overlay || typeof document === 'undefined') return
    overlay = renderOverlay(pairUrl(), hideQR)
    document.body.append(overlay)
  }

  function hideQR() {
    overlay?.remove()
    overlay = undefined
  }

  scheduleState()
  void pollLoop()

  return {
    controls(controls) {
      declared = controls
      scheduleState()
    },
    on(action: string, fn: (...args: never[]) => void) {
      const set = handlers.get(action) ?? new Set()
      const handler = fn as (...args: unknown[]) => void
      set.add(handler)
      handlers.set(action, set)
      return () => void set.delete(handler)
    },
    setState(patch) {
      state = { ...state, ...patch }
      scheduleState()
    },
    showQR,
    hideQR,
    get pairUrl() {
      return pairUrl()
    },
    onPairUrl(fn) {
      pairFns.add(fn)
      return () => void pairFns.delete(fn)
    },
    close() {
      if (closed) return
      closed = true
      endSession()
      if (typeof removeEventListener === 'function') removeEventListener('pagehide', endSession)
      abort.abort()
      clearInterval(heartbeat)
      clearTimeout(batchTimer)
      for (const t of timers) clearTimeout(t)
      hideQR()
    },
  }
}
