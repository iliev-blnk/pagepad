import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { toNodeHandler } from '../src/node'
import { createRelay } from '../src/server/relay'
import { memoryStore } from '../src/stores/memory'

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

async function listen() {
  const relay = createRelay({ store: memoryStore(), ui: '<p>ui</p>' })
  const s = createServer(toNodeHandler(relay))
  server = s
  await new Promise<void>((r) => s.listen(0, r))
  return `http://localhost:${(s.address() as AddressInfo).port}`
}

describe('toNodeHandler', () => {
  it('passes JSON bodies through and returns the relay response', async () => {
    const base = await listen()
    const res = await fetch(base, { method: 'POST', body: JSON.stringify({ op: 'create' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Object.keys(await res.json()).sort()).toEqual(['hostToken', 'id', 'secret'])
  })

  it('passes query strings and headers through', async () => {
    const base = await listen()
    const html = await fetch(`${base}/?s=x`, { headers: { accept: 'text/html' } })
    expect(await html.text()).toBe('<p>ui</p>')
    const poll = await fetch(`${base}/?op=poll&id=nope`, { headers: { authorization: 'Bearer x' } })
    expect(poll.status).toBe(404)
  })
})
