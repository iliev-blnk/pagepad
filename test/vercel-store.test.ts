import { describe, expect, it, vi } from 'vitest'

const cache = new Map<string, unknown>()
vi.mock('@vercel/functions', () => ({
  getCache: () => ({
    get: async (k: string) => cache.get(k),
    set: async (k: string, v: unknown) => void cache.set(k, v),
    delete: async (k: string) => void cache.delete(k),
  }),
}))

const { vercelStore } = await import('../src/stores/vercel')

describe('vercelStore', () => {
  it('round-trips push and range', async () => {
    const store = vercelStore()
    await store.push('q', { action: 'a' }, { max: 50, ttlSec: 60 })
    await store.push('q', { action: 'b' }, { max: 50, ttlSec: 60 })
    const { seq, items } = await store.range('q')
    expect(seq).toBe(2)
    expect(items.map((i) => [i.id, i.action])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ])
  })

  it('round-trips get and set', async () => {
    const store = vercelStore()
    await store.set('k', { a: 1 }, 30)
    expect(await store.get('k')).toEqual({ a: 1 })
  })

  it('is not atomic', () => {
    expect(vercelStore().atomic).toBe(false)
  })
})
