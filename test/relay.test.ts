import { describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/server/relay'
import { memoryStore } from '../src/stores/memory'
import { relaySuite } from './relay.suite'

relaySuite('memory', memoryStore)

describe('createRelay', () => {
  it('warns once when the store is not atomic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createRelay({ store: { ...memoryStore(), atomic: false } })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('does not warn for an atomic store', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createRelay({ store: memoryStore() })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
