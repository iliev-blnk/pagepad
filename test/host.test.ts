// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, type Host } from '../src/host'
import { createRelay } from '../src/server/relay'
import { memoryStore } from '../src/stores/memory'

const CREDS = { id: 'ID', hostToken: 'HOST', secret: 'SEC' }

interface Logged {
  url: URL
  init: RequestInit | undefined
  body: Record<string, unknown> | null
}

/** Records requests. Polls hang unless `pollReply` returns a response. */
function stubFetch(pollReply?: () => Response | undefined) {
  const log: Logged[] = []
  const pending: Array<(r: Response) => void> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    log.push({ url, init, body })
    if (body?.op === 'create') return Response.json(CREDS)
    if (body?.op === 'state') return Response.json({ seq: 0, reset: false, cmds: [] })
    const reply = pollReply?.()
    if (reply) return reply
    return new Promise<Response>((resolve, reject) => {
      pending.push(resolve)
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      )
    })
  }
  const of = (op: string) => log.filter((l) => (l.body?.op ?? l.url.searchParams.get('op')) === op)
  return { fetch: fetch as typeof globalThis.fetch, log, of, pending }
}

/** Routes fetch to an in-process relay so phone-side commands reach the host for real. */
function relayFetch() {
  const relay = createRelay({ store: memoryStore(), pollStepMs: 10, maxWaitMs: 100 })
  const fetch = (input: string | URL | Request, init?: RequestInit) =>
    relay.handler(new Request(String(input), init))
  return { relay, fetch: fetch as typeof globalThis.fetch }
}

let host: Host | undefined

beforeEach(() => {
  ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
    'https://x.test/app/',
  )
})

afterEach(() => {
  host?.close()
  host = undefined
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('createHost', () => {
  it('builds an absolute pair URL from a relative endpoint', async () => {
    host = await createHost({ endpoint: '/api/pad', fetch: stubFetch().fetch })
    expect(host.pairUrl).toBe('https://x.test/api/pad?s=ID#SEC')
  })

  it('dispatches phone commands to named and catch-all handlers', async () => {
    const { relay, fetch } = relayFetch()
    host = await createHost({ endpoint: 'https://x.test/api/pad', fetch, pollWaitSec: 1 })
    const pair = new URL(host.pairUrl)
    const named = vi.fn()
    const all = vi.fn()
    host.on('volume', named)
    host.on('*', all)
    await relay.handler(
      new Request('https://x.test/api/pad', {
        method: 'POST',
        body: JSON.stringify({
          op: 'cmd',
          id: pair.searchParams.get('s'),
          secret: pair.hash.slice(1),
          action: 'volume',
          value: 40,
        }),
      }),
    )
    await vi.waitFor(() => expect(named).toHaveBeenCalledWith(40))
    expect(all).toHaveBeenCalledWith('volume', 40)
  })

  it('stops calling a handler after unsubscribe', async () => {
    const { relay, fetch } = relayFetch()
    host = await createHost({ endpoint: 'https://x.test/api/pad', fetch, pollWaitSec: 1 })
    const pair = new URL(host.pairUrl)
    const fn = vi.fn()
    const all = vi.fn()
    host.on('next', fn)()
    host.on('*', all)
    await relay.handler(
      new Request('https://x.test/api/pad', {
        method: 'POST',
        body: JSON.stringify({
          op: 'cmd',
          id: pair.searchParams.get('s'),
          secret: pair.hash.slice(1),
          action: 'next',
        }),
      }),
    )
    await vi.waitFor(() => expect(all).toHaveBeenCalled())
    expect(fn).not.toHaveBeenCalled()
  })

  it('debounces state updates into one merged request and resends on heartbeat', async () => {
    vi.useFakeTimers()
    const stub = stubFetch()
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    await vi.advanceTimersByTimeAsync(300)
    const before = stub.of('state').length
    host.setState({ title: 'A' })
    await vi.advanceTimersByTimeAsync(100)
    host.setState({ volume: 5 })
    await vi.advanceTimersByTimeAsync(149)
    expect(stub.of('state').length).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(stub.of('state').length).toBe(before + 1)
    expect(stub.of('state').at(-1)?.body?.state).toEqual({ title: 'A', volume: 5 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stub.of('state').length).toBe(before + 2)
  })

  it('sends declared controls with the next state request', async () => {
    vi.useFakeTimers()
    const stub = stubFetch()
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    const controls = { next: { button: 'Next' } }
    host.controls(controls)
    await vi.advanceTimersByTimeAsync(250)
    expect(stub.of('state').at(-1)?.body?.controls).toEqual(controls)
  })

  it('backs off 1s, 2s, 4s when the relay fails, then resumes', async () => {
    vi.useFakeTimers()
    let polls = 0
    const stub = stubFetch(() => {
      polls++
      if (polls <= 3) return new Response('down', { status: 503 })
      if (polls === 4)
        return Response.json({ seq: 1, reset: false, cmds: [{ id: 1, action: 'go', value: null }] })
      return undefined
    })
    const fn = vi.fn()
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    host.on('go', fn)
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.of('poll').length).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(stub.of('poll').length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(stub.of('poll').length).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(stub.of('poll').length).toBe(3)
    await vi.advanceTimersByTimeAsync(3999)
    expect(stub.of('poll').length).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('caps the backoff at 15 seconds', async () => {
    vi.useFakeTimers()
    const stub = stubFetch(() => new Response('down', { status: 503 }))
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000)
    const n = stub.of('poll').length
    await vi.advanceTimersByTimeAsync(14_999)
    expect(stub.of('poll').length).toBe(n)
    await vi.advanceTimersByTimeAsync(1)
    expect(stub.of('poll').length).toBe(n + 1)
  })

  it('starts a new session when the relay has forgotten this one', async () => {
    vi.useFakeTimers()
    let first = true
    const stub = stubFetch(() => {
      if (first) {
        first = false
        return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
      }
      return new Response('down', { status: 503 })
    })
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    const onPair = vi.fn()
    host.onPairUrl(onPair)
    host.showQR()
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.of('create').length).toBe(2)
    expect(onPair).toHaveBeenCalledWith('https://x.test/api/pad?s=ID#SEC')
  })

  it('shows and hides the QR overlay', async () => {
    host = await createHost({ endpoint: '/api/pad', fetch: stubFetch().fetch })
    host.showQR()
    host.showQR()
    const overlays = document.querySelectorAll('[data-pagepad-qr]')
    expect(overlays.length).toBe(1)
    expect(overlays[0]?.querySelector('svg')).not.toBeNull()
    expect(overlays[0]?.textContent).toContain('x.test/api/pad')
    host.hideQR()
    expect(document.querySelector('[data-pagepad-qr]')).toBeNull()
  })

  it('ends the session on the relay when closed', async () => {
    const stub = stubFetch()
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    host.close()
    const end = stub.of('end')
    expect(end).toHaveLength(1)
    expect(end[0]?.body).toEqual({ op: 'end', id: 'ID', hostToken: 'HOST' })
    expect(end[0]?.init?.keepalive).toBe(true)
  })

  it('ends the session when the page is hidden for navigation', async () => {
    const stub = stubFetch()
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    window.dispatchEvent(new Event('pagehide'))
    expect(stub.of('end')).toHaveLength(1)
  })

  it('stops all requests after close', async () => {
    vi.useFakeTimers()
    const stub = stubFetch(() => new Response('down', { status: 503 }))
    host = await createHost({ endpoint: '/api/pad', fetch: stub.fetch })
    host.setState({ a: 1 })
    host.close()
    const n = stub.log.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stub.log.length).toBe(n)
  })
})
