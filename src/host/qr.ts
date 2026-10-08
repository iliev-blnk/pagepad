import { renderSVG } from 'uqr'

/** Fixed bottom-right card with the pairing QR, a link, and a close button. */
export function renderOverlay(pairUrl: string, onClose: () => void): HTMLElement {
  const url = new URL(pairUrl)
  const card = document.createElement('div')
  card.setAttribute('data-pagepad-qr', '')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Pair a phone')
  Object.assign(card.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    width: '192px',
    padding: '12px',
    background: '#fff',
    color: '#111',
    border: '1px solid #111',
    font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    boxShadow: '0 8px 24px rgba(0,0,0,.18)',
  })

  const qr = document.createElement('div')
  qr.innerHTML = renderSVG(pairUrl, { border: 1, pixelSize: 4 })
  const svg = qr.querySelector('svg')
  if (svg) Object.assign(svg.style, { display: 'block', width: '100%', height: 'auto' })

  const label = document.createElement('div')
  label.textContent = 'Scan to control this page'
  label.style.margin = '8px 0 2px'

  const link = document.createElement('a')
  link.href = pairUrl
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = url.host + url.pathname
  Object.assign(link.style, {
    color: 'inherit',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Hide pairing code')
  Object.assign(close.style, {
    position: 'absolute',
    top: '-12px',
    right: '-12px',
    width: '24px',
    height: '24px',
    border: '1px solid #111',
    borderRadius: '50%',
    background: '#fff',
    color: '#111',
    cursor: 'pointer',
    font: '14px/1 system-ui, sans-serif',
  })
  close.addEventListener('click', onClose)

  card.append(qr, label, link, close)
  return card
}
