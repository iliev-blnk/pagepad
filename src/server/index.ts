import { UI_HTML } from '../ui/generated'
import { createRelay as createBareRelay, type RelayOptions } from './relay'

export { memoryStore } from '../stores/memory'
export type { Command, Control, Controls, Store } from '../types'
export type { Relay, RelayOptions } from './relay'

/** Relay handler with the built-in phone UI. Mount it at one URL for GET and POST. */
export function createRelay(options: RelayOptions) {
  return createBareRelay({ ui: UI_HTML, ...options })
}
