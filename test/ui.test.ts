// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Controls } from '../src/types'
import { renderApp } from '../src/ui/render'

type StateFn = (s: { state: Record<string, unknown> | null; controls: Controls | null }) => void

function fakePad() {
  const sent: { action: string; value: unknown }[] = []
  let stateFn: StateFn = () => {}
  let endFn = () => {}
  return {
    sent,
    pad: {
      send: async (action: string, value?: unknown) => void sent.push({ action, value }),
      onState: (fn: StateFn) => {
        stateFn = fn
        return () => {}
      },
      onEnd: (fn: () => void) => {
        endFn = fn
        return () => {}
      },
    },
    push: (state: Record<string, unknown>, controls: Controls) => stateFn({ state, controls }),
    end: () => endFn(),
  }
}

let root: HTMLElement
beforeEach(() => {
  root = document.createElement('main')
  document.body.append(root)
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('phone UI', () => {
  it('renders the header and reflects state in a slider', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({ title: 'Song', subtitle: 'Artist', volume: 30 }, { volume: { slider: [0, 100] } })
    expect(root.querySelector('h1')?.textContent).toBe('Song')
    expect(root.textContent).toContain('Artist')
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')
    expect(slider?.value).toBe('30')
    expect(slider?.min).toBe('0')
    expect(slider?.max).toBe('100')
  })

  it('renders state text as text, not HTML', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({ title: '<img src=x onerror=alert(1)>' }, {})
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('sends the control key when a button is tapped', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({}, { next: { button: 'Next' } })
    const button = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Next')
    button?.click()
    expect(f.sent).toEqual([{ action: 'next', value: null }])
  })

  it('puts up to four consecutive buttons in one row', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push(
      {},
      {
        prev: { button: 'Prev' },
        toggle: { button: 'Play' },
        next: { button: 'Next' },
        fade: { toggle: 'Fade' },
        a: { button: 'A' },
        b: { button: 'B' },
        c: { button: 'C' },
        d: { button: 'D' },
        e: { button: 'E' },
      },
    )
    const grids = [...root.querySelectorAll<HTMLElement>('.buttons')]
    expect(grids.map((g) => g.style.gridTemplateColumns)).toEqual([
      'repeat(3, 1fr)',
      'repeat(3, 1fr)',
    ])
  })

  it('sends the opposite of the current toggle state', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({ fade: true }, { fade: { toggle: 'Fade' } })
    const sw = root.querySelector<HTMLButtonElement>('[role=switch]')
    expect(sw?.getAttribute('aria-checked')).toBe('true')
    sw?.click()
    expect(f.sent).toEqual([{ action: 'fade', value: false }])
  })

  it('sends the chosen option and marks the current one', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({ mode: 'repeat' }, { mode: { select: ['shuffle', 'repeat'] } })
    const options = [...root.querySelectorAll<HTMLButtonElement>('[data-option]')]
    expect(options.map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    options[0]?.click()
    expect(f.sent).toEqual([{ action: 'mode', value: 'shuffle' }])
  })

  it('throttles slider drags and always sends the final value', async () => {
    vi.useFakeTimers()
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({}, { volume: { slider: [0, 100] } })
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')
    if (!slider) throw new Error('no slider')
    for (let v = 1; v <= 10; v++) {
      slider.value = String(v)
      slider.dispatchEvent(new Event('input'))
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(f.sent.length).toBeLessThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(f.sent.length).toBeLessThanOrEqual(2)
    expect(f.sent.at(-1)).toEqual({ action: 'volume', value: 10 })
  })

  it('does not jump the slider back while the user is dragging', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({ volume: 30 }, { volume: { slider: [0, 100] } })
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')
    if (!slider) throw new Error('no slider')
    slider.value = '80'
    slider.dispatchEvent(new Event('input'))
    f.push({ volume: 30 }, { volume: { slider: [0, 100] } })
    expect(slider.value).toBe('80')
  })

  it('tells the user when the session has ended', () => {
    const f = fakePad()
    renderApp(root, f.pad)
    f.push({}, { next: { button: 'Next' } })
    f.end()
    expect(root.textContent).toContain('Session ended — scan the code again')
    expect(root.querySelector('button')).toBeNull()
  })
})
