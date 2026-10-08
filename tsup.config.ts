import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'host/index': 'src/host/index.ts',
    'remote/index': 'src/remote/index.ts',
    'server/index': 'src/server/index.ts',
    'node/index': 'src/node/index.ts',
    'stores/upstash': 'src/stores/upstash.ts',
    'stores/vercel': 'src/stores/vercel.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  target: 'es2022',
  noExternal: ['uqr'],
  external: ['@vercel/functions'],
})
