// Records media/demo.gif: the player demo on a desktop next to the paired phone.
// Usage: pnpm build && node scripts/record-demo.mjs   (needs ffmpeg)
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const out = mkdtempSync(join(tmpdir(), 'pagepad-rec-'))
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const deskCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: join(out, 'desk'), size: { width: 1280, height: 800 } },
  })
  const deskStart = Date.now()
  const desk = await deskCtx.newPage()
  await desk.goto(`${base}/player.html`)
  await desk.waitForFunction(() => '__pagepad' in window)
  const pairUrl = await desk.evaluate(() => window.__pagepad.pairUrl)
  await pause(1200)

  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    recordVideo: { dir: join(out, 'phone'), size: { width: 390, height: 844 } },
  })
  const phoneStart = Date.now()
  const phone = await phoneCtx.newPage()
  await phone.goto(pairUrl)
  await phone.waitForSelector('.status.live')
  await pause(900)
  await desk.evaluate(() => window.__pagepad.hideQR())
  await pause(400)
  const tap = async (name) => {
    await phone.getByRole('button', { name, exact: true }).tap()
    await pause(1300)
  }
  await tap('Next')
  await tap('Play')
  const slider = phone.locator('input[type=range]')
  for (let v = 66; v >= 30; v -= 4) {
    await slider.fill(String(v))
    await pause(70)
  }
  await pause(1200)
  await tap('Next')
  await tap('Pause')
  const end = Date.now()

  await deskCtx.close()
  await phoneCtx.close()
  const deskVideo = await desk.video().path()
  const phoneVideo = await phone.video().path()

  const offset = ((phoneStart - deskStart) / 1000).toFixed(2)
  const length = ((end - phoneStart) / 1000).toFixed(2)
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    offset,
    '-t',
    length,
    '-i',
    deskVideo,
    '-t',
    length,
    '-i',
    phoneVideo,
    '-filter_complex',
    [
      '[0:v]scale=1024:640,pad=1024+48:640+48:24:24:color=0xf2f2f2[d]',
      '[1:v]scale=296:640,pad=296+24:640+48:0:24:color=0xf2f2f2[p]',
      '[d][p]hstack,fps=12,split[a][b]',
      '[a]palettegen=stats_mode=diff[pal]',
      '[b][pal]paletteuse=dither=bayer:bayer_scale=4',
    ].join(';'),
    'media/demo.gif',
  ])
  console.log('wrote media/demo.gif')
} finally {
  await browser.close()
  server.kill()
  rmSync(out, { recursive: true, force: true })
}
