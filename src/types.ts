export type Control =
  | { button: string }
  | { toggle: string }
  | { slider: [min: number, max: number, step?: number] }
  | { select: string[] }

export type Controls = Record<string, Control>

export interface Command {
  id: number
  action: string
  value: unknown
  at: number
}

export interface PushOptions {
  max: number
  ttlSec: number
}

/** Persistence used by the relay. `push` must hand out increasing ids per key. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, ttlSec: number): Promise<void>
  push(key: string, item: object, opts: PushOptions): Promise<number>
  range(key: string): Promise<{ seq: number; items: Command[] }>
  /** True when concurrent pushes can never lose an item. */
  readonly atomic: boolean
}
