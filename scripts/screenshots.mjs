// Captures README media: each demo on desktop next to its paired phone remote.
// Usage: pnpm build && node scripts/screenshots.mjs
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const server = spawn(process.execPath, ['demo/server.mjs'], { env: { ...process.env, PORT: '0' } })
const base = await new Promise((resolve) =>
  server.stdout.on('data', (c) => {
    const m = /http:\/\/localhost:\d+/.exec(c.toString())
    if (m) resolve(m[0])
  }),
)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
})
const scheme = process.env.SCHEME ?? 'light'

try {
  for (const name of ['player', 'slides', 'game']) {
    const desk = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    })
    await desk.goto(`${base}/${name}.html`)
    await desk.waitForFunction(() => '__pagepad' in window)
    const pairUrl = await desk.evaluate(() => window.__pagepad.pairUrl)
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: scheme,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    })
    await phone.goto(pairUrl)
    await phone.waitForSelector('.status.live')
    if (name === 'player') await phone.getByRole('button', { name: 'Next' }).click()
    if (name === 'slides') await phone.getByRole('button', { name: 'Next' }).click()
    if (name === 'game') {
      for (const k of ['→', '→', '↓', '→', '↑', '↑'])
        await phone.getByRole('button', { name: k }).click()
    }
    await desk.waitForTimeout(1500)
    await phone.waitForTimeout(1200)
    await desk.screenshot({ path: `media/${name}-desktop-${scheme}.png` })
    await phone.screenshot({ path: `media/${name}-phone-${scheme}.png` })
    console.log('captured', name)
  }
} finally {
  await browser.close()
  server.kill()
}
