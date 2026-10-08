import type { PadSnapshot } from '../remote'
import type { Control, Controls } from '../types'

export interface PadLike {
  send(action: string, value?: unknown): Promise<void>
  onState(fn: (snapshot: PadSnapshot) => void): () => void
  onEnd(fn: () => void): () => void
}

const SEND_EVERY_MS = 100
const HOLD_AFTER_INPUT_MS = 1000

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: Node[]
) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

const humanize = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

/** At most one call per `ms`, always including the last value. */
function throttle<T>(fn: (v: T) => void, ms: number) {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: T
  return (v: T) => {
    pending = v
    if (timer) return
    const wait = last + ms - Date.now()
    if (wait <= 0) {
      last = Date.now()
      fn(v)
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      last = Date.now()
      fn(pending)
    }, wait)
  }
}

type Updater = (state: Record<string, unknown>) => void

export function renderApp(root: HTMLElement, pad: PadLike) {
  const send = (action: string, value: unknown = null) => {
    pad.send(action, value).catch(() => {})
  }

  const status = el('p', { className: 'status', textContent: 'Connecting…' })
  const title = el('h1')
  const subtitle = el('p', { className: 'sub' })
  const list = el('section', { className: 'controls' })
  root.replaceChildren(el('header', {}, status, title, subtitle), list)

  let shape = ''
  let updaters: Updater[] = []

  function button(key: string, label: string) {
    const b = el('button', { type: 'button', className: 'action', textContent: label })
    b.addEventListener('click', () => send(key))
    return b
  }

  function toggle(key: string, label: string): [Node, Updater] {
    const sw = el('button', { type: 'button', className: 'switch' })
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', 'false')
    sw.setAttribute('aria-label', label)
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', String(next))
      send(key, next)
    })
    const row = el('div', { className: 'row' }, el('span', { textContent: label }), sw)
    return [row, (s) => sw.setAttribute('aria-checked', String(s[key] === true))]
  }

  function slider(key: string, [min, max, step = 1]: [number, number, number?]): [Node, Updater] {
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
    })
    input.setAttribute('aria-label', humanize(key))
    const value = el('span', { className: 'value' })
    let lastInput = 0
    let dragging = false
    const push = throttle((v: number) => send(key, v), SEND_EVERY_MS)
    input.addEventListener('input', () => {
      lastInput = Date.now()
      value.textContent = input.value
      push(Number(input.value))
    })
    input.addEventListener('pointerdown', () => {
      dragging = true
    })
    input.addEventListener('pointerup', () => {
      dragging = false
    })
    const head = el(
      'div',
      { className: 'row head' },
      el('span', { textContent: humanize(key) }),
      value,
    )
    const row = el('div', { className: 'slider' }, head, input)
    return [
      row,
      (s) => {
        const v = s[key]
        if (typeof v !== 'number' || dragging || Date.now() - lastInput < HOLD_AFTER_INPUT_MS)
          return
        input.value = String(v)
        value.textContent = input.value
      },
    ]
  }

  function select(key: string, options: string[]): [Node, Updater] {
    const buttons = options.map((option) => {
      const b = el('button', { type: 'button', textContent: option })
      b.dataset.option = option
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('click', () => {
        for (const o of buttons) o.setAttribute('aria-pressed', String(o === b))
        send(key, option)
      })
      return b
    })
    const group = el('div', { className: 'segmented' }, ...buttons)
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', humanize(key))
    const row = el(
      'div',
      { className: 'select' },
      el('span', { textContent: humanize(key) }),
      group,
    )
    return [
      row,
      (s) => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(s[key] === b.dataset.option))
      },
    ]
  }

  function build(controls: Controls) {
    updaters = []
    const nodes: Node[] = []
    let grid: HTMLElement | undefined
    for (const [key, control] of Object.entries(controls) as [string, Control][]) {
      if ('button' in control) {
        if (!grid) {
          grid = el('div', { className: 'buttons' })
          nodes.push(grid)
        }
        grid.append(button(key, control.button || humanize(key)))
        continue
      }
      grid = undefined
      const [node, update] =
        'toggle' in control
          ? toggle(key, control.toggle || humanize(key))
          : 'slider' in control
            ? slider(key, control.slider)
            : select(key, control.select)
      nodes.push(node)
      updaters.push(update)
    }
    for (const node of nodes) {
      if (node instanceof HTMLElement && node.className === 'buttons') {
        const n = node.children.length
        const columns = n <= 4 ? n : n % 4 === 0 ? 4 : 3
        node.style.gridTemplateColumns = `repeat(${columns}, 1fr)`
      }
    }
    list.replaceChildren(...nodes)
  }

  pad.onState(({ state, controls }) => {
    const s = state ?? {}
    status.textContent = 'Connected'
    status.classList.add('live')
    title.textContent = typeof s.title === 'string' ? s.title : ''
    subtitle.textContent = typeof s.subtitle === 'string' ? s.subtitle : ''
    const next = JSON.stringify(controls ?? {})
    if (next !== shape) {
      shape = next
      build(controls ?? {})
    }
    for (const update of updaters) update(s)
  })

  pad.onEnd(() => {
    root.replaceChildren(
      el(
        'div',
        { className: 'ended' },
        el('p', { textContent: 'Session ended — scan the code again' }),
      ),
    )
  })
}
