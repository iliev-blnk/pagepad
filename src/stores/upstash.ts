import type { Command, Store } from '../types'

export interface UpstashOptions {
  /** REST URL, e.g. `UPSTASH_REDIS_REST_URL`. */
  url: string
  /** REST token, e.g. `UPSTASH_REDIS_REST_TOKEN`. */
  token: string
  fetch?: typeof fetch
}

type Reply = { result?: unknown; error?: string }

// Takes the next id and stores the command in one atomic step, so a reader can
// never see a seq whose command is not in the list yet. ARGV[1] is the command
// as a JSON object; the id is spliced in as its first field.
const PUSH = `local id = redis.call('INCR', KEYS[2])
redis.call('RPUSH', KEYS[1], '{"id":' .. id .. ',' .. string.sub(ARGV[1], 2))
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return id`

/**
 * Upstash Redis over its REST API. Atomic: each push is one Lua script and
 * each read is one MULTI/EXEC transaction.
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
      const json = JSON.stringify(item)
      if (!json.startsWith('{"')) throw new Error('[pagepad] queue items must be non-empty objects')
      return Number(
        await one(['EVAL', PUSH, '2', key, `${key}:seq`, json, String(max), String(ttlSec)]),
      )
    },
    async range(key) {
      const [seq, list] = await many('/multi-exec', [
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
