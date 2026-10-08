import type { Command, Store } from '../types'

export interface UpstashOptions {
  /** REST URL, e.g. `UPSTASH_REDIS_REST_URL`. */
  url: string
  /** REST token, e.g. `UPSTASH_REDIS_REST_TOKEN`. */
  token: string
  fetch?: typeof fetch
}

type Reply = { result?: unknown; error?: string }

/**
 * Upstash Redis over its REST API. Atomic: ids come from INCR and the
 * push/trim/expire runs as one MULTI/EXEC transaction.
 */
export function upstashStore(options: UpstashOptions): Store {
  const base = options.url.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function request(path: string, body: unknown) {
    const res = await doFetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Reply | Reply[]
    const failed = Array.isArray(data) ? data.find((r) => r.error) : data.error ? data : undefined
    if (!res.ok || failed) {
      throw new Error(`[pagepad] Upstash: ${failed?.error ?? `HTTP ${res.status}`}`)
    }
    return data
  }

  const one = async (cmd: string[]) => ((await request('', cmd)) as Reply).result
  const many = async (path: string, cmds: string[][]) =>
    ((await request(path, cmds)) as Reply[]).map((r) => r.result)

  return {
    atomic: true,
    async get<T>(key: string) {
      const raw = await one(['GET', key])
      return typeof raw === 'string' ? (JSON.parse(raw) as T) : undefined
    },
    async set(key, value, ttlSec) {
      await one(['SET', key, JSON.stringify(value), 'EX', String(ttlSec)])
    },
    async push(key, item, { max, ttlSec }) {
      const id = Number(await one(['INCR', `${key}:seq`]))
      await many('/multi-exec', [
        ['RPUSH', key, JSON.stringify({ ...item, id })],
        ['LTRIM', key, String(-max), '-1'],
        ['EXPIRE', key, String(ttlSec)],
        ['EXPIRE', `${key}:seq`, String(ttlSec)],
      ])
      return id
    },
    async range(key) {
      const [seq, list] = await many('/pipeline', [
        ['GET', `${key}:seq`],
        ['LRANGE', key, '0', '-1'],
      ])
      const items = ((list as string[] | null) ?? [])
        .map((s) => JSON.parse(s) as Command)
        .sort((a, b) => a.id - b.id)
      return { seq: Number(seq ?? 0), items }
    },
  }
}
