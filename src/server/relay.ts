import type { Command, Controls, Store } from '../types'
import { randomToken, safeEqual, sha256 } from './crypto'

export interface RelayOptions {
  store: Store
  /** How often a waiting poll re-reads the store. Lower = snappier, more store reads. */
  pollStepMs?: number
  /** Upper bound for one long-poll. Keep below your platform's function timeout. */
  maxWaitMs?: number
  /** HTML served to browsers that open the pair URL. */
  ui?: string
}

interface Session {
  hostHash: string
  secretHash: string
  controls: Controls | null
}

type ErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'BAD_REQUEST' | 'UNKNOWN_ACTION' | 'TOO_LARGE'

// Refreshed by every host state post (at least every 10 s), so a closed page
// shows up as ended on the phone within two minutes even without `op: 'end'`.
const SESSION_TTL = 120
const QUEUE_MAX = 50
const STALE_MS = 60_000
const MAX_STATE = 16 * 1024
const MAX_VALUE = 1024
const MAX_BODY = 64 * 1024
const MAX_ACTION = 64

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  UNKNOWN_ACTION: 400,
  TOO_LARGE: 413,
}

const keys = (id: string) => ({ session: `pp:${id}:s`, state: `pp:${id}:st`, queue: `pp:${id}:q` })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const fail = (code: ErrorCode) => json({ error: code }, STATUS[code])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? '').length

const bearer = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Commands after the client's cursor, minus stale ones. `reset` means the queue restarted. */
function fresh(queue: { seq: number; items: Command[] }, since: number) {
  const cutoff = Date.now() - STALE_MS
  const reset = queue.seq < since
  const items = reset ? queue.items : queue.items.filter((c) => c.id > since)
  return { seq: queue.seq, reset, cmds: items.filter((c) => c.at > cutoff) }
}

export function createRelay(options: RelayOptions) {
  const { store, pollStepMs = 750, maxWaitMs = 25_000 } = options
  const ui = options.ui ?? '<!doctype html><title>pagepad</title><p>pagepad relay</p>'

  if (!store.atomic) {
    console.warn(
      '[pagepad] This store is not atomic: two remotes sending at the same moment can lose a command.',
    )
  }

  async function load(id: unknown) {
    if (typeof id !== 'string' || !id) return undefined
    return store.get<Session>(keys(id).session)
  }

  async function check(hash: string, token: unknown) {
    return typeof token === 'string' && safeEqual(hash, await sha256(token))
  }

  async function create() {
    const id = randomToken()
    const hostToken = randomToken()
    const secret = randomToken()
    const session: Session = {
      hostHash: await sha256(hostToken),
      secretHash: await sha256(secret),
      controls: null,
    }
    await store.set(keys(id).session, session, SESSION_TTL)
    return json({ id, hostToken, secret })
  }

  async function command(body: Record<string, unknown>) {
    const session = await load(body.id)
    if (!session) return fail('NOT_FOUND')
    if (!(await check(session.secretHash, body.secret))) return fail('UNAUTHORIZED')
    const { action } = body
    if (typeof action !== 'string' || !action || action.length > MAX_ACTION) {
      return fail('BAD_REQUEST')
    }
    if (session.controls && !Object.hasOwn(session.controls, action)) return fail('UNKNOWN_ACTION')
    const value = body.value ?? null
    if (byteLength(value) > MAX_VALUE) return fail('TOO_LARGE')
    const seq = await store.push(
      keys(body.id as string).queue,
      { action, value, at: Date.now() },
      { max: QUEUE_MAX, ttlSec: SESSION_TTL },
    )
    return json({ seq })
  }

  async function hostState(body: Record<string, unknown>) {
    const id = body.id as string
    const session = await load(id)
    if (!session) return fail('NOT_FOUND')
    if (!(await check(session.hostHash, body.hostToken))) return fail('UNAUTHORIZED')
    const state = body.state ?? {}
    if (!isObject(state)) return fail('BAD_REQUEST')
    if (byteLength(state) > MAX_STATE) return fail('TOO_LARGE')
    if (body.controls !== undefined) {
      if (!isObject(body.controls)) return fail('BAD_REQUEST')
      if (byteLength(body.controls) > MAX_STATE) return fail('TOO_LARGE')
      session.controls = body.controls as Controls
    }
    const k = keys(id)
    await Promise.all([
      store.set(k.state, state, SESSION_TTL),
      store.set(k.session, session, SESSION_TTL),
    ])
    return json(fresh(await store.range(k.queue), Number(body.since) || 0))
  }

  async function end(body: Record<string, unknown>) {
    const id = body.id as string
    const session = await load(id)
    if (!session) return json({ ok: true })
    if (!(await check(session.hostHash, body.hostToken))) return fail('UNAUTHORIZED')
    const k = keys(id)
    await Promise.all([store.set(k.session, null, 60), store.set(k.state, null, 60)])
    return json({ ok: true })
  }

  async function poll(req: Request, params: URLSearchParams) {
    const id = params.get('id') ?? ''
    const session = await load(id)
    if (!session) return fail('NOT_FOUND')
    if (!(await check(session.hostHash, bearer(req)))) return fail('UNAUTHORIZED')
    // No session write here: it could overwrite controls posted meanwhile.
    // State posts (at least every 10 s) keep the session alive.
    const k = keys(id)
    const since = Number(params.get('since')) || 0
    const wait = Math.max(0, Number(params.get('wait')) || 0) * 1000
    const deadline = Date.now() + Math.min(wait, maxWaitMs)
    for (;;) {
      const result = fresh(await store.range(k.queue), since)
      if (result.cmds.length || result.reset || Date.now() >= deadline) return json(result)
      await sleep(pollStepMs)
    }
  }

  async function phoneState(req: Request, params: URLSearchParams) {
    const id = params.get('id') ?? ''
    const session = await load(id)
    if (!session) return fail('NOT_FOUND')
    if (!(await check(session.secretHash, bearer(req)))) return fail('UNAUTHORIZED')
    const state = (await store.get(keys(id).state)) ?? null
    return json({ state, controls: session.controls, now: Date.now() })
  }

  async function handler(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      const text = await req.text()
      if (text.length > MAX_BODY) return fail('TOO_LARGE')
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return fail('BAD_REQUEST')
      }
      if (!isObject(body)) return fail('BAD_REQUEST')
      if (body.op === 'create') return create()
      if (body.op === 'cmd') return command(body)
      if (body.op === 'state') return hostState(body)
      if (body.op === 'end') return end(body)
      return fail('BAD_REQUEST')
    }

    if (req.method === 'GET') {
      const params = new URL(req.url).searchParams
      const op = params.get('op')
      if (op === 'poll') return poll(req, params)
      if (op === 'state') return phoneState(req, params)
      if (!op && req.headers.get('accept')?.includes('text/html')) {
        return new Response(ui, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      return fail('BAD_REQUEST')
    }

    return json({ error: 'METHOD_NOT_ALLOWED' }, 405)
  }

  return { handler, GET: handler, POST: handler }
}

export type Relay = ReturnType<typeof createRelay>
