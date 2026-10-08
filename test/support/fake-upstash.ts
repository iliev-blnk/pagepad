type Cmd = string[]

/** Minimal in-memory interpreter for the Upstash REST commands pagepad uses. */
export function fakeUpstash() {
  const strings = new Map<string, string>()
  const lists = new Map<string, string[]>()
  const requests: { url: string; auth: string | null; body: unknown }[] = []

  const run = ([op, key = '', ...args]: Cmd): unknown => {
    switch (op) {
      case 'GET':
        return strings.get(key) ?? null
      case 'SET':
        strings.set(key, args[0] ?? '')
        return 'OK'
      case 'INCR': {
        const n = Number(strings.get(key) ?? 0) + 1
        strings.set(key, String(n))
        return n
      }
      case 'RPUSH': {
        const list = lists.get(key) ?? []
        list.push(...args)
        lists.set(key, list)
        return list.length
      }
      case 'LTRIM': {
        const list = lists.get(key) ?? []
        const start = Number(args[0])
        lists.set(key, list.slice(start < 0 ? Math.max(0, list.length + start) : start))
        return 'OK'
      }
      case 'LRANGE':
        return [...(lists.get(key) ?? [])]
      case 'EXPIRE':
        return 1
      default:
        throw new Error(`fake upstash: unsupported ${op}`)
    }
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    const auth = new Headers(init?.headers).get('authorization')
    requests.push({ url, auth, body })
    const path = new URL(url).pathname
    const result =
      path.endsWith('/pipeline') || path.endsWith('/multi-exec')
        ? (body as Cmd[]).map((c) => ({ result: run(c) }))
        : { result: run(body as Cmd) }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
  }

  return { fetch: fetch as typeof globalThis.fetch, requests }
}
