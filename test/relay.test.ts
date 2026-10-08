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
