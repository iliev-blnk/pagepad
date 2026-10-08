// Cloudflare Worker for the hosted demo: relay at /api/pad, demo pages as static assets.
import { createRelay, memoryStore } from '../../dist/server/index.js'
import { upstashStore } from '../../dist/stores/upstash.js'

let relay

function getRelay(env, hostname) {
  if (!relay) {
    const local = hostname === 'localhost' || hostname === '127.0.0.1'
    let store
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      store = upstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    } else if (local) {
      // `wrangler dev` runs one isolate, so the in-memory store is enough there.
      store = memoryStore()
    } else {
      return undefined
    }
    // Each wait step is one Upstash request; 20 s at 750 ms stays under the
    // Workers free-tier limit of 50 subrequests per invocation.
    relay = createRelay({ store, maxWaitMs: 20_000 })
  }
  return relay
}

export default {
  async fetch(request, env) {
    const { pathname, hostname } = new URL(request.url)
    if (pathname !== '/api/pad') return env.ASSETS.fetch(request)
    const r = getRelay(env, hostname)
    if (!r) {
      return Response.json(
        {
          error: 'Upstash secrets missing: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN',
        },
        { status: 500 },
      )
    }
    try {
      return await r.handler(request)
    } catch (err) {
      console.error('relay failed', err)
      return Response.json({ error: 'STORE_UNAVAILABLE' }, { status: 502 })
    }
  },
}
