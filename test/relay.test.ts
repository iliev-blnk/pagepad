import { describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/server/relay'
import { memoryStore } from '../src/stores/memory'
import type { Store } from '../src/types'
import { call, relaySuite } from './relay.suite'

relaySuite('memory', memoryStore)

describe('relay under store latency', () => {
  it('keeps controls posted while a poll is starting', async () => {
    const inner = memoryStore()
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const store: Store = {
      ...inner,
      async set(key, value, ttl) {
        const session = value as { controls?: unknown } | null
        if (key.endsWith(':s') && session && session.controls === null && polling) await held
        return inner.set(key, value, ttl)
      },
    }
    let polling = false
    const relay = createRelay({ store, pollStepMs: 10, maxWaitMs: 50 })
    const { body: s } = await call(relay, 'POST', { op: 'create' })
    polling = true
    const poll = call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 1 }, s.hostToken)
    await new Promise((r) => setTimeout(r, 5))
    const controls = { next: { button: 'Next' } }
    await call(relay, 'POST', {
      op: 'state',
      id: s.id,
      hostToken: s.hostToken,
      state: {},
      controls,
      since: 0,
    })
    release()
    await poll
    const phone = await call(relay, 'GET', { op: 'state', id: s.id }, s.secret)
    expect(phone.body.controls).toEqual(controls)
  })
})

describe('createRelay', () => {
  it('warns once when the store is not atomic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createRelay({ store: { ...memoryStore(), atomic: false } })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('does not warn for an atomic store', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createRelay({ store: memoryStore() })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('cross-origin access', () => {
  const preflight = (origin: string) =>
    new Request('https://relay.test/api/pad', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
  const create = (origin: string) =>
    new Request('https://relay.test/api/pad', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create' }),
    })

  it('answers preflights and tags responses for an allowed origin', async () => {
    const relay = createRelay({ store: memoryStore(), allowOrigin: ['https://app.test'] })
    const pre = await relay.handler(preflight('https://app.test'))
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.test')
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type, authorization')
    const res = await relay.handler(create('https://app.test'))
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('leaves other origins without CORS headers', async () => {
    const relay = createRelay({ store: memoryStore(), allowOrigin: 'https://app.test' })
    const res = await relay.handler(create('https://evil.test'))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows any origin with "*"', async () => {
    const relay = createRelay({ store: memoryStore(), allowOrigin: '*' })
    const res = await relay.handler(create('https://anything.test'))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('is same-origin only by default', async () => {
    const relay = createRelay({ store: memoryStore() })
    const res = await relay.handler(create('https://app.test'))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
