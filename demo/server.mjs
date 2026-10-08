// Local demo server: static demo pages, the built package under /pagepad/, and a relay at /api/pad.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toNodeHandler } from '../dist/node/index.js'
import { createRelay, memoryStore } from '../dist/server/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const relay = toNodeHandler(createRelay({ store: memoryStore() }))
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function serveFile(res, dir, path) {
  const file = normalize(join(root, dir, path))
  if (!file.startsWith(join(root, dir))) return notFound(res)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    notFound(res)
  }
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/api/pad') return relay(req, res)
  if (pathname.startsWith('/pagepad/')) return serveFile(res, 'dist', pathname.slice(9))
  return serveFile(res, 'demo', pathname === '/' ? 'index.html' : pathname)
})

server.listen(Number(process.env.PORT ?? 5173), () => {
  const { port } = server.address()
  console.log(`pagepad demo: http://localhost:${port}`)
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal)
        console.log(`  on your network: http://${net.address}:${port}`)
    }
  }
})
