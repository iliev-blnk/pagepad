import type { IncomingMessage, ServerResponse } from 'node:http'

interface Handles {
  handler(req: Request): Promise<Response>
}

/** Adapt a relay to Node's `http` / Express `(req, res)` signature. */
export function toNodeHandler(relay: Handles) {
  return (req: IncomingMessage, res: ServerResponse) => {
    void handle(relay, req, res).catch((err) => {
      console.error('[pagepad]', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }
}

async function handle(relay: Handles, req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const response = await relay.handler(
    new Request(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}
