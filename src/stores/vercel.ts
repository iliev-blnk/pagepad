import { getCache } from '@vercel/functions'
import type { Command, Store } from '../types'

interface Queue {
  seq: number
  items: Command[]
}

/**
 * Vercel Runtime Cache. Zero setup on Vercel, but not atomic: two remotes
 * sending at the same moment can lose a command. Fine for one remote.
 */
export function vercelStore(): Store {
  const cache = () => getCache()

  return {
    atomic: false,
    async get<T>(key: string) {
      return ((await cache().get(key)) ?? undefined) as T | undefined
    },
    async set(key, value, ttlSec) {
      await cache().set(key, value, { ttl: ttlSec })
    },
    async push(key, item, { max, ttlSec }) {
      const queue = ((await cache().get(key)) as Queue | null) ?? { seq: 0, items: [] }
      const seq = queue.seq + 1
      const items = [...queue.items, { ...item, id: seq } as Command].slice(-max)
      await cache().set(key, { seq, items }, { ttl: ttlSec })
      return seq
    },
    async range(key) {
      const queue = (await cache().get(key)) as Queue | null
      return queue ? { seq: queue.seq, items: queue.items } : { seq: 0, items: [] }
    },
  }
}
