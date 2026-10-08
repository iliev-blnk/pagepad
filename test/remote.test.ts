// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect, type Pad } from '../src/remote'

const URL_ = 'https://x.test/api/pad?s=ID#SEC'

function stub(stateStatus = 200) {
  const log: { url: URL; init?: RequestInit }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    log.push({ url, init })
    if (url.searchParams.get('op') === 'state') {
      if (stateStatus === 404) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
      return Response.json({ state: { title: 'Song' }, controls: { next: { button: 'Next' } } })
    }
    return Response.json({ seq: 1 })
  }
  const states = () => log.filter((l) => l.url.searchParams.get('op') === 'state')
  return { fetch: fetch as typeof globalThis.fetch, log, states }
}

let pad: Pad | undefined
afterEach(() => {
  pad?.close()
  pad = undefined
  vi.useRealTimers()
})

describe('connect', () => {
  it('sends commands with the session id and secret from the pair URL', async () => {
    const s = stub()
    pad = connect(URL_, { fetch: s.fetch })
    await pad.send('volume', 40)
    const cmd = s.log.find((l) => l.init?.method === 'POST')
    expect(cmd?.url.toString()).toBe('https://x.test/api/pad')
    expect(JSON.parse(String(cmd?.init?.body))).toEqual({
      op: 'cmd',
      id: 'ID',
      secret: 'SEC',
      action: 'volume',
      value: 40,
    })
  })

  it('reads state with the secret as a bearer token', async () => {
    const s = stub()
    pad = connect(URL_, { fetch: s.fetch })
    const fn = vi.fn()
    pad.onState(fn)
    await vi.waitFor(() =>
      expect(fn).toHaveBeenCalledWith({
        state: { title: 'Song' },
        controls: { next: { button: 'Next' } },
      }),
    )
    const req = s.states()[0]
    expect(req?.url.searchParams.get('id')).toBe('ID')
    expect(new Headers(req?.init?.headers).get('authorization')).toBe('Bearer SEC')
  })

  it('polls state on an interval', async () => {
    vi.useFakeTimers()
    const s = stub()
    pad = connect(URL_, { fetch: s.fetch, pollMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.states().length).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.states().length).toBe(2)
  })

  it('reads state immediately when the page becomes visible again', async () => {
    vi.useFakeTimers()
    const s = stub()
    pad = connect(URL_, { fetch: s.fetch, pollMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.states().length).toBe(2)
  })

  it('ends once and stops polling when the session is gone', async () => {
    vi.useFakeTimers()
    const s = stub(404)
    pad = connect(URL_, { fetch: s.fetch, pollMs: 1000 })
    const end = vi.fn()
    pad.onEnd(end)
    await vi.advanceTimersByTimeAsync(5000)
    expect(end).toHaveBeenCalledTimes(1)
    expect(s.states().length).toBe(1)
  })
})
