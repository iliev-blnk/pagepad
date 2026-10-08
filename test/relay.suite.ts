import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/server/relay'
import type { Store } from '../src/types'

type Relay = ReturnType<typeof createRelay>
const BASE = 'https://x.test/api/pad'

export async function call(
  relay: Relay,
  method: 'GET' | 'POST',
  data: Record<string, unknown>,
  auth?: string,
) {
  const headers: Record<string, string> = {}
  if (auth) headers.authorization = `Bearer ${auth}`
  let req: Request
  if (method === 'GET') {
    const url = new URL(BASE)
    for (const [k, v] of Object.entries(data)) url.searchParams.set(k, String(v))
    req = new Request(url, { headers })
  } else {
    headers['content-type'] = 'application/json'
    req = new Request(BASE, { method, headers, body: JSON.stringify(data) })
  }
  const res = await relay.handler(req)
  const text = await res.text()
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body, headers: res.headers }
}

export function relaySuite(name: string, makeStore: () => Store) {
  describe(`relay (${name})`, () => {
    const make = (ui?: string) =>
      createRelay({ store: makeStore(), pollStepMs: 10, maxWaitMs: 200, ui })

    async function session(relay: Relay) {
      const { body } = await call(relay, 'POST', { op: 'create' })
      return body as { id: string; hostToken: string; secret: string }
    }

    afterEach(() => vi.restoreAllMocks())

    it('creates sessions with distinct 22-char base64url credentials', async () => {
      const relay = make()
      const s = await session(relay)
      for (const v of [s.id, s.hostToken, s.secret]) expect(v).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(new Set([s.id, s.hostToken, s.secret]).size).toBe(3)
      const res = await call(relay, 'POST', { op: 'create' })
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('rejects a command with the wrong secret', async () => {
      const relay = make()
      const s = await session(relay)
      const res = await call(relay, 'POST', { op: 'cmd', id: s.id, secret: 'nope', action: 'a' })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' })
    })

    it('returns 404 for an unknown session', async () => {
      const relay = make()
      const res = await call(relay, 'POST', { op: 'cmd', id: 'x', secret: 'y', action: 'a' })
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'NOT_FOUND' })
    })

    it('rejects a poll with the wrong host token', async () => {
      const relay = make()
      const s = await session(relay)
      const res = await call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 0 }, s.secret)
      expect(res.status).toBe(401)
    })

    it('delivers a command to the host poll', async () => {
      const relay = make()
      const s = await session(relay)
      await call(relay, 'POST', {
        op: 'cmd',
        id: s.id,
        secret: s.secret,
        action: 'volume',
        value: 40,
      })
      const res = await call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 1 }, s.hostToken)
      expect(res.status).toBe(200)
      expect(res.body.seq).toBe(1)
      expect(res.body.reset).toBe(false)
      expect(res.body.cmds[0]).toMatchObject({ id: 1, action: 'volume', value: 40 })
    })

    it('holds an empty poll until the deadline', async () => {
      const relay = make()
      const s = await session(relay)
      const t0 = Date.now()
      const res = await call(
        relay,
        'GET',
        { op: 'poll', id: s.id, since: 0, wait: 25 },
        s.hostToken,
      )
      expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
      expect(res.body.cmds).toEqual([])
    })

    it('answers a waiting poll as soon as a command arrives', async () => {
      const relay = make()
      const s = await session(relay)
      const t0 = Date.now()
      const poll = call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 25 }, s.hostToken)
      await new Promise((r) => setTimeout(r, 50))
      await call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action: 'next' })
      const res = await poll
      expect(Date.now() - t0).toBeLessThan(190)
      expect(res.body.cmds.map((c: { action: string }) => c.action)).toEqual(['next'])
    })

    it('stores host state and controls for the phone', async () => {
      const relay = make()
      const s = await session(relay)
      const controls = { next: { button: 'Next' } }
      const res = await call(relay, 'POST', {
        op: 'state',
        id: s.id,
        hostToken: s.hostToken,
        state: { title: 'Song' },
        controls,
        since: 0,
      })
      expect(res.status).toBe(200)
      const phone = await call(relay, 'GET', { op: 'state', id: s.id }, s.secret)
      expect(phone.body.state).toEqual({ title: 'Song' })
      expect(phone.body.controls).toEqual(controls)
      expect(typeof phone.body.now).toBe('number')
    })

    it('keeps controls when a later state update omits them', async () => {
      const relay = make()
      const s = await session(relay)
      const controls = { next: { button: 'Next' } }
      const base = { op: 'state', id: s.id, hostToken: s.hostToken, since: 0 }
      await call(relay, 'POST', { ...base, state: { a: 1 }, controls })
      await call(relay, 'POST', { ...base, state: { a: 2 } })
      const phone = await call(relay, 'GET', { op: 'state', id: s.id }, s.secret)
      expect(phone.body.controls).toEqual(controls)
    })

    it('rejects a phone state read with the host token', async () => {
      const relay = make()
      const s = await session(relay)
      const res = await call(relay, 'GET', { op: 'state', id: s.id }, s.hostToken)
      expect(res.status).toBe(401)
    })

    it('piggybacks pending commands on the state reply', async () => {
      const relay = make()
      const s = await session(relay)
      for (const action of ['a', 'b'])
        await call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action })
      const res = await call(relay, 'POST', {
        op: 'state',
        id: s.id,
        hostToken: s.hostToken,
        state: {},
        since: 1,
      })
      expect(res.body.seq).toBe(2)
      expect(res.body.cmds.map((c: { action: string }) => c.action)).toEqual(['b'])
    })

    it('drops commands older than 60 seconds', async () => {
      const relay = make()
      const s = await session(relay)
      await call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action: 'old' })
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
      const res = await call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 0 }, s.hostToken)
      expect(res.body.cmds).toEqual([])
    })

    it('signals a reset when the client cursor is ahead of the queue', async () => {
      const relay = make()
      const s = await session(relay)
      for (const action of ['a', 'b'])
        await call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action })
      const res = await call(
        relay,
        'GET',
        { op: 'poll', id: s.id, since: 10, wait: 0 },
        s.hostToken,
      )
      expect(res.body.reset).toBe(true)
      expect(res.body.cmds.map((c: { id: number }) => c.id)).toEqual([1, 2])
    })

    it('only accepts declared actions once controls are set', async () => {
      const relay = make()
      const s = await session(relay)
      const cmd = (action: string) =>
        call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action })
      expect((await cmd('jump')).status).toBe(200)
      await call(relay, 'POST', {
        op: 'state',
        id: s.id,
        hostToken: s.hostToken,
        state: {},
        controls: { next: { button: 'Next' } },
        since: 0,
      })
      const res = await cmd('jump')
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'UNKNOWN_ACTION' })
      expect((await cmd('next')).status).toBe(200)
    })

    it('rejects an action longer than 64 characters', async () => {
      const relay = make()
      const s = await session(relay)
      const res = await call(relay, 'POST', {
        op: 'cmd',
        id: s.id,
        secret: s.secret,
        action: 'a'.repeat(65),
      })
      expect(res.status).toBe(400)
    })

    it('rejects state over 16 KB and values over 1 KB', async () => {
      const relay = make()
      const s = await session(relay)
      const big = await call(relay, 'POST', {
        op: 'state',
        id: s.id,
        hostToken: s.hostToken,
        state: { blob: 'x'.repeat(17 * 1024) },
        since: 0,
      })
      expect(big.status).toBe(413)
      expect(big.body).toEqual({ error: 'TOO_LARGE' })
      const value = await call(relay, 'POST', {
        op: 'cmd',
        id: s.id,
        secret: s.secret,
        action: 'a',
        value: 'x'.repeat(2 * 1024),
      })
      expect(value.status).toBe(413)
    })

    it('delivers both of two simultaneous commands', async () => {
      const relay = make()
      const s = await session(relay)
      await Promise.all(
        ['a', 'b'].map((action) =>
          call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action }),
        ),
      )
      const res = await call(relay, 'GET', { op: 'poll', id: s.id, since: 0, wait: 0 }, s.hostToken)
      expect(res.body.cmds.map((c: { id: number }) => c.id)).toEqual([1, 2])
    })

    it('ends a session so the phone sees it is gone', async () => {
      const relay = make()
      const s = await session(relay)
      const wrong = await call(relay, 'POST', { op: 'end', id: s.id, hostToken: s.secret })
      expect(wrong.status).toBe(401)
      const res = await call(relay, 'POST', { op: 'end', id: s.id, hostToken: s.hostToken })
      expect(res.status).toBe(200)
      const phone = await call(relay, 'GET', { op: 'state', id: s.id }, s.secret)
      expect(phone.status).toBe(404)
      const cmd = await call(relay, 'POST', { op: 'cmd', id: s.id, secret: s.secret, action: 'a' })
      expect(cmd.status).toBe(404)
    })

    it('expires a session two minutes after the host goes quiet', async () => {
      const relay = make()
      const s = await session(relay)
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + 121_000)
      const phone = await call(relay, 'GET', { op: 'state', id: s.id }, s.secret)
      expect(phone.status).toBe(404)
    })

    it('rejects an unknown op', async () => {
      const res = await call(make(), 'POST', { op: 'dance' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'BAD_REQUEST' })
    })

    it('serves the phone UI to a browser', async () => {
      const relay = make('<!doctype html><p>pad</p>')
      const res = await relay.handler(
        new Request(`${BASE}?s=x`, { headers: { accept: 'text/html,application/xhtml+xml' } }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toBe('<!doctype html><p>pad</p>')
    })
  })
}
