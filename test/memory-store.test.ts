import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryStore } from '../src/stores/memory'

afterEach(() => vi.useRealTimers())

describe('memoryStore', () => {
  it('returns a value until its ttl runs out', async () => {
    vi.useFakeTimers()
    const store = memoryStore()
    await store.set('k', { a: 1 }, 2)
    expect(await store.get('k')).toEqual({ a: 1 })
    vi.advanceTimersByTime(2001)
    expect(await store.get('k')).toBeUndefined()
  })

  it('assigns increasing ids on push', async () => {
    const store = memoryStore()
    const opts = { max: 50, ttlSec: 60 }
    expect(await store.push('q', { action: 'a' }, opts)).toBe(1)
    expect(await store.push('q', { action: 'b' }, opts)).toBe(2)
    expect(await store.push('q', { action: 'c' }, opts)).toBe(3)
    const { seq, items } = await store.range('q')
    expect(seq).toBe(3)
    expect(items.map((i) => i.id)).toEqual([1, 2, 3])
  })

  it('keeps only the newest max items but keeps counting', async () => {
    const store = memoryStore()
    const opts = { max: 2, ttlSec: 60 }
    for (const action of ['a', 'b', 'c']) await store.push('q', { action }, opts)
    const { seq, items } = await store.range('q')
    expect(seq).toBe(3)
    expect(items.map((i) => i.id)).toEqual([2, 3])
  })

  it('returns an empty range for a missing key', async () => {
    expect(await memoryStore().range('nope')).toEqual({ seq: 0, items: [] })
  })

  it('gives concurrent pushes distinct ids', async () => {
    const store = memoryStore()
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => store.push('q', {}, { max: 50, ttlSec: 60 })),
    )
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('returns copies, like a networked store would', async () => {
    const store = memoryStore()
    const value = { controls: null as unknown }
    await store.set('k', value, 60)
    value.controls = 'changed after set'
    const read = await store.get<{ controls: unknown }>('k')
    expect(read?.controls).toBeNull()
    if (read) read.controls = 'changed after get'
    expect((await store.get<{ controls: unknown }>('k'))?.controls).toBeNull()
  })

  it('is atomic', () => {
    expect(memoryStore().atomic).toBe(true)
  })
})
