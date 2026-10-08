// Cloudflare Worker for the hosted demo: relay at /api/pad, demo pages as static assets.
import { createRelay, memoryStore } from '../../dist/server/index.js'
import { upstashStore } from '../../dist/stores/upstash.js'

let relay

function getRelay(env) {
  if (!relay) {
    // Without Upstash credentials (local `wrangler dev`), one isolate serves
    // everything, so the in-memory store is enough.
    const store = env.UPSTASH_REDIS_REST_URL
      ? upstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
      : memoryStore()
    // Each wait step is one Upstash request; 20 s at 750 ms stays under the
    // Workers free-tier limit of 50 subrequests per invocation.
    relay = createRelay({ store, maxWaitMs: 20_000 })
  }
  return relay
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/pad') return getRelay(env).handler(request)
    return env.ASSETS.fetch(request)
  },
}
