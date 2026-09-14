// Ambient capabilities that are not part of the WebExtension API: the clock,
// uuids and timers. Injected so tests stay deterministic.

export interface Environment {
  randomUUID(): string
  now(): number
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(timerId: number): void
}

export function realEnvironment(): Environment {
  return {
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs) as unknown as number,
    clearTimeout: (timerId) => clearTimeout(timerId),
  }
}
