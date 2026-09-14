// The native messaging link to `firefox-ctl host`: one port, both frame directions
// and reconnect with exponential backoff.

import type { Browser, Port } from "./browser"
import type { Environment } from "./env"
import type {
  ExtensionRequest,
  ExtensionResponse,
  HostCommand,
  HostRequestName,
  JsonValue,
} from "./protocol"
import { isHostCommand } from "./protocol"

/** Native application name; matches the manifest written by `firefox-ctl install`. */
export const NATIVE_HOST = "firefoxctl"

/** Default lifetime of an extension-initiated request. */
export const TIMEOUT_MS = 150000

export const RECONNECT = {
  maxAttempts: 10,
  initialDelayMs: 1000,
  backoffMultiplier: 1.5,
  maxDelayMs: 30000,
  // a connection counts as stable after this long without a disconnect
  stableAfterMs: 5000,
} as const

/** Posts the dispatcher's answer back to the port the command arrived on. */
export type Reply = (response: ExtensionResponse) => void

export type CommandListener = (command: HostCommand, reply: Reply) => void

export interface LinkStatus {
  connected: boolean
  attempt: number
  lastDisconnectReason: string | null
  reconnectScheduled: boolean
}

interface PendingRequest {
  command: HostRequestName
  timer: number
  resolve(result: JsonValue): void
  reject(error: Error): void
}

interface ReplyFrame {
  id?: unknown
  success?: unknown
  result?: unknown
  error?: unknown
}

export class NativeLink {
  private port: Port | null = null
  private attempt = 0
  private reconnectTimer: number | null = null
  private stableTimer: number | null = null
  private lastDisconnectReason: string | null = null
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly browser: Browser,
    private readonly env: Environment,
    private readonly onCommand: CommandListener,
    private readonly hostName: string = NATIVE_HOST,
  ) {}

  connect(): void {
    if (this.port) {
      return
    }
    try {
      const port = this.browser.runtime.connectNative(this.hostName)
      this.port = port
      port.onMessage.addListener((message) => {
        this.receive(port, message)
      })
      port.onDisconnect.addListener(() => {
        this.handleDisconnect(port)
      })
      this.clearReconnectTimer()
      this.lastDisconnectReason = null
      this.stableTimer = this.env.setTimeout(() => {
        this.stableTimer = null
        this.attempt = 0
      }, RECONNECT.stableAfterMs)
      console.log(`[firefox-ctl] connected to native host ${this.hostName}`)
    } catch (error) {
      this.port = null
      console.error(`[firefox-ctl] connect failed: ${describe(error)}`)
      this.scheduleReconnect()
    }
  }

  /** Sends an extension-initiated request; only `ping` and `version` are answered. */
  send(command: HostRequestName, timeoutMs: number = TIMEOUT_MS): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      const port = this.port
      if (!port) {
        reject(new Error("Not connected to native host"))
        return
      }
      const id = this.env.randomUUID()
      const timer = this.env.setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Request timed out after ${timeoutMs}ms (command: ${command})`))
        }
      }, timeoutMs)
      this.pending.set(id, { command, timer, resolve, reject })

      const request: ExtensionRequest = { id, command }
      try {
        port.postMessage(request)
      } catch (error) {
        this.pending.delete(id)
        this.env.clearTimeout(timer)
        reject(new Error(`Failed to send ${command}: ${describe(error)}`))
      }
    })
  }

  status(): LinkStatus {
    return {
      connected: this.port !== null,
      attempt: this.attempt,
      lastDisconnectReason: this.lastDisconnectReason,
      reconnectScheduled: this.reconnectTimer !== null,
    }
  }

  private receive(port: Port, message: unknown): void {
    if (this.port === port) {
      this.markStable()
    }
    if (isHostCommand(message)) {
      // the closure captures the port, so a late answer never lands on a newer one
      this.onCommand(message, (response) => {
        this.postReply(port, response)
      })
      return
    }
    this.resolvePending(message)
  }

  private postReply(port: Port, response: ExtensionResponse): void {
    if (this.port !== port) {
      console.warn(`[firefox-ctl] dropping reply ${response.id}: its port is gone`)
      return
    }
    port.postMessage(response)
  }

  private resolvePending(message: unknown): void {
    const frame = (message ?? {}) as ReplyFrame
    if (typeof frame.id !== "string") {
      console.warn("[firefox-ctl] ignoring frame without an id")
      return
    }
    const request = this.pending.get(frame.id)
    if (!request) {
      console.warn(`[firefox-ctl] ignoring reply for unknown id ${frame.id}`)
      return
    }
    this.pending.delete(frame.id)
    this.env.clearTimeout(request.timer)
    if (frame.success === true) {
      request.resolve((frame.result ?? null) as JsonValue)
      return
    }
    request.reject(new Error(typeof frame.error === "string" ? frame.error : "Unknown error"))
  }

  private handleDisconnect(port: Port): void {
    if (this.port !== port) {
      return
    }
    const reason = port.error?.message ?? "Unknown disconnect reason"
    this.port = null
    this.lastDisconnectReason = reason
    if (this.stableTimer !== null) {
      this.env.clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    this.rejectPending(`Native host disconnected: ${reason}`)
    console.log(`[firefox-ctl] disconnected from native host: ${reason}`)
    this.scheduleReconnect()
  }

  private rejectPending(reason: string): void {
    for (const request of this.pending.values()) {
      this.env.clearTimeout(request.timer)
      request.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private markStable(): void {
    if (this.stableTimer === null) {
      return
    }
    this.env.clearTimeout(this.stableTimer)
    this.stableTimer = null
    this.attempt = 0
  }

  private scheduleReconnect(): void {
    if (this.port || this.reconnectTimer !== null) {
      return
    }
    if (this.attempt >= RECONNECT.maxAttempts) {
      console.log(`[firefox-ctl] giving up after ${RECONNECT.maxAttempts} reconnect attempts`)
      this.attempt = 0
      return
    }
    const delay = Math.min(
      RECONNECT.initialDelayMs * RECONNECT.backoffMultiplier ** this.attempt,
      RECONNECT.maxDelayMs,
    )
    this.attempt++
    console.log(
      `[firefox-ctl] reconnect attempt ${this.attempt}/${RECONNECT.maxAttempts} in ${delay}ms`,
    )
    this.reconnectTimer = this.env.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.env.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
