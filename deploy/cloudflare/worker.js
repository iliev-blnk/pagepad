// Cloudflare Worker for the hosted demo: demo pages as static assets, relay at /api/pad.
//
// The relay runs inside one Durable Object. A Durable Object instance handles
// its requests on a single thread, so the plain in-memory store is consistent
// and atomic there: no external database or secrets needed. An open long-poll
// keeps the object alive; if it is ever evicted, hosts get a 404 and start a
// new session on their own.
import { DurableObject } from 'cloudflare:workers'
import { createRelay, memoryStore } from '../../dist/server/index.js'

export class PadRelay extends DurableObject {
  relay = createRelay({ store: memoryStore() })

  fetch(request) {
    return this.relay.handler(request)
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname !== '/api/pad') return env.ASSETS.fetch(request)
    return env.PAD.get(env.PAD.idFromName('demo')).fetch(request)
  },
}
