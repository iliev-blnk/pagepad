// Assembles the static demo site for deploy/cloudflare: demo pages plus dist/ under /pagepad/.
import { cp, rm } from 'node:fs/promises'

const out = new URL('../deploy/cloudflare/site/', import.meta.url)
await rm(out, { recursive: true, force: true })
await cp(new URL('../demo/', import.meta.url), out, {
  recursive: true,
  filter: (src) => !src.endsWith('server.mjs'),
})
await cp(new URL('../dist/', import.meta.url), new URL('pagepad/', out), {
  recursive: true,
  filter: (src) => !src.endsWith('.d.ts'),
})
console.log('site: deploy/cloudflare/site')
