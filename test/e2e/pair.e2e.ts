import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let server: ChildProcess
let browser: Browser
let base: string

beforeAll(async () => {
  if (!existsSync('dist/server/index.js')) throw new Error('Run `pnpm build` before the e2e test.')
  server = spawn(process.execPath, ['demo/server.mjs'], { env: { ...process.env, PORT: '0' } })
  base = await new Promise<string>((resolve, reject) => {
    server.stdout?.on('data', (chunk: Buffer) => {
      const match = /http:\/\/localhost:\d+/.exec(chunk.toString())
      if (match) resolve(match[0])
    })
    server.on('exit', (code) => reject(new Error(`demo server exited with ${code}`)))
  })
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  })
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

describe('pairing a phone with the player demo', () => {
  it('controls the player from the phone UI', async () => {
    const desktop = await browser.newPage()
    await desktop.goto(`${base}/player.html`)
    await desktop.waitForFunction(() => '__pagepad' in window && '__player' in window)
    const pairUrl = await desktop.evaluate(
      () => (window as unknown as { __pagepad: { pairUrl: string } }).__pagepad.pairUrl,
    )

    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    const phone = await phoneContext.newPage()
    await phone.goto(pairUrl)
    await phone.getByRole('button', { name: 'Next' }).click()
    await phone.locator('input[type=range]').fill('20')

    await desktop.waitForFunction(
      () => {
        const p = (window as unknown as { __player: { index: number; volume: number } }).__player
        return p.index === 1 && Math.abs(p.volume - 0.2) < 1e-9
      },
      undefined,
      { timeout: 5000 },
    )

    const title = await desktop.evaluate(
      () =>
        (window as unknown as { __player: { tracks: { title: string }[] } }).__player.tracks[1]
          ?.title,
    )
    await expect.poll(() => phone.locator('h1').textContent(), { timeout: 3000 }).toBe(title)
  })
})
