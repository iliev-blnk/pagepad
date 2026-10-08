import type { Command, Store } from '../types'

interface Entry {
  value: unknown
  expires: number
}

interface Queue {
  seq: number
  items: Command[]
}

/** In-process store for development and tests. Not shared between server instances. */
export function memoryStore(): Store {
  const data = new Map<string, Entry>()

  const read = <T>(key: string): T | undefined => {
    const entry = data.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      data.delete(key)
      return undefined
    }
    return entry.value as T
  }

  const write = (key: string, value: unknown, ttlSec: number) => {
    data.set(key, { value, expires: Date.now() + ttlSec * 1000 })
  }

  return {
    atomic: true,
    async get(key) {
      return read(key)
    },
    async set(key, value, ttlSec) {
      write(key, value, ttlSec)
    },
    async push(key, item, { max, ttlSec }) {
      const queue = read<Queue>(key) ?? { seq: 0, items: [] }
      const seq = queue.seq + 1
      const items = [...queue.items, { ...item, id: seq } as Command].slice(-max)
      write(key, { seq, items }, ttlSec)
      return seq
    },
    async range(key) {
      const queue = read<Queue>(key)
      return queue ? { seq: queue.seq, items: [...queue.items] } : { seq: 0, items: [] }
    },
  }
}
