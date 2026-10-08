import { describe, expect, it } from 'vitest'
import { upstashStore } from '../src/stores/upstash'
import { relaySuite } from './relay.suite'
import { fakeUpstash } from './support/fake-upstash'

const URL_ = 'https://eu1-x.upstash.io'

describe('upstashStore', () => {
  it('pushes with one atomic EVAL request', async () => {
    const up = fakeUpstash()
    const store = upstashStore({ url: URL_, token: 'tok', fetch: up.fetch })
    expect(await store.push('q', { a: 1 }, { max: 50, ttlSec: 60 })).toBe(1)
    expect(up.requests).toHaveLength(1)
    const req = up.requests[0]
    expect(req?.url).toBe(URL_)
    expect(req?.auth).toBe('Bearer tok')
    const [op, script, numKeys, ...rest] = req?.body as string[]
    expect(op).toBe('EVAL')
    expect(script).toContain("redis.call('INCR', KEYS[2])")
    expect(numKeys).toBe('2')
    expect(rest).toEqual(['q', 'q:seq', '{"a":1}', '50', '60'])
    const { items } = await store.range('q')
    expect(items).toEqual([{ id: 1, a: 1 }])
  })

  it('never shows a seq whose command is missing while pushes interleave', async () => {
    const up = fakeUpstash({ delay: (n) => (n * 7) % 13 })
    const store = upstashStore({ url: URL_, token: 'tok', fetch: up.fetch })
    const opts = { max: 50, ttlSec: 60 }
    const work: Promise<unknown>[] = []
    const snapshots: Promise<{ seq: number; items: { id: number }[] }>[] = []
    for (let i = 0; i < 12; i++) {
      work.push(store.push('q', { n: i }, opts))
      snapshots.push(store.range('q'))
    }
    await Promise.all(work)
    for (const snap of await Promise.all(snapshots)) {
      expect(snap.items.map((c) => c.id)).toEqual(Array.from({ length: snap.seq }, (_, i) => i + 1))
    }
  })

  it('reads seq and items in one transaction, sorted by id', async () => {
    const up = fakeUpstash()
    const store = upstashStore({ url: URL_, token: 'tok', fetch: up.fetch })
    await up.fetch(`${URL_}/pipeline`, {
      method: 'POST',
      body: JSON.stringify([
        ['SET', 'q:seq', '2'],
        [
          'RPUSH',
          'q',
          JSON.stringify({ id: 2, action: 'b' }),
          JSON.stringify({ id: 1, action: 'a' }),
        ],
      ]),
    })
    up.requests.length = 0
    const { seq, items } = await store.range('q')
    expect(up.requests[0]).toMatchObject({
      url: `${URL_}/multi-exec`,
      body: [
        ['GET', 'q:seq'],
        ['LRANGE', 'q', '0', '-1'],
      ],
    })
    expect(seq).toBe(2)
    expect(items.map((i) => i.id)).toEqual([1, 2])
  })

  it('stores JSON values with SET EX and reads them with GET', async () => {
    const up = fakeUpstash()
    const store = upstashStore({ url: `${URL_}/`, token: 'tok', fetch: up.fetch })
    await store.set('k', { a: 1 }, 30)
    expect(up.requests[0]?.body).toEqual(['SET', 'k', '{"a":1}', 'EX', '30'])
    expect(up.requests[0]?.url).toBe(URL_)
    expect(await store.get('k')).toEqual({ a: 1 })
    expect(await store.get('missing')).toBeUndefined()
  })

  it('throws with the Upstash error message on failure', async () => {
    const store = upstashStore({
      url: URL_,
      token: 'bad',
      fetch: async () => new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 }),
    })
    await expect(store.get('k')).rejects.toThrow('WRONGPASS')
  })

  it('is atomic', () => {
    expect(upstashStore({ url: URL_, token: 't', fetch: fakeUpstash().fetch }).atomic).toBe(true)
  })
})

relaySuite('upstash', () => upstashStore({ url: URL_, token: 't', fetch: fakeUpstash().fetch }))
