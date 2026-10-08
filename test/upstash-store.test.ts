import { describe, expect, it } from 'vitest'
import { upstashStore } from '../src/stores/upstash'
import { relaySuite } from './relay.suite'
import { fakeUpstash } from './support/fake-upstash'

const URL_ = 'https://eu1-x.upstash.io'

describe('upstashStore', () => {
  it('takes an id with INCR, then pushes, trims and expires in one transaction', async () => {
    const up = fakeUpstash()
    const store = upstashStore({ url: URL_, token: 'tok', fetch: up.fetch })
    expect(await store.push('q', { a: 1 }, { max: 50, ttlSec: 60 })).toBe(1)
    expect(up.requests).toHaveLength(2)
    expect(up.requests[0]).toEqual({ url: URL_, auth: 'Bearer tok', body: ['INCR', 'q:seq'] })
    const tx = up.requests[1]
    expect(tx?.url).toBe(`${URL_}/multi-exec`)
    expect(tx?.auth).toBe('Bearer tok')
    const body = tx?.body as string[][]
    expect(body[0]?.slice(0, 2)).toEqual(['RPUSH', 'q'])
    expect(JSON.parse(body[0]?.[2] ?? '')).toEqual({ a: 1, id: 1 })
    expect(body.slice(1)).toEqual([
      ['LTRIM', 'q', '-50', '-1'],
      ['EXPIRE', 'q', '60'],
      ['EXPIRE', 'q:seq', '60'],
    ])
  })

  it('reads seq and items in one pipeline, sorted by id', async () => {
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
      url: `${URL_}/pipeline`,
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
