import { describe, expect, test } from "bun:test"
import { NativeLink, RECONNECT, TIMEOUT_MS } from "../src/port"
import type { ExtensionResponse, HostCommand } from "../src/protocol"
import { FakeBrowser, FakeEnvironment, type FakePort } from "./fakes"

interface Seen {
  command: HostCommand
  reply: (response: ExtensionResponse) => void
}

function setup(): {
  browser: FakeBrowser
  env: FakeEnvironment
  link: NativeLink
  commands: Seen[]
} {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment()
  const commands: Seen[] = []
  const link = new NativeLink(browser, env, (command, reply) => {
    commands.push({ command, reply })
  })
  return { browser, env, link, commands }
}

function hostCommand(id: string, command: string): HostCommand {
  return { id, type: "command", command, params: {} }
}

function livePort(browser: FakeBrowser): FakePort {
  const port = browser.lastPort()
  if (!port) {
    throw new Error("no port was created")
  }
  return port
}

describe("NativeLink.connect", () => {
  test("connects to the firefox-ctl host and posts nothing on its own", () => {
    const { browser, link } = setup()
    link.connect()
    expect(browser.connectedHosts).toEqual(["firefoxctl"])
    expect(livePort(browser).posted).toEqual([])
    expect(link.status()).toEqual({
      connected: true,
      attempt: 0,
      lastDisconnectReason: null,
      reconnectScheduled: false,
    })
  })

  test("is a no-op while already connected", () => {
    const { browser, link } = setup()
    link.connect()
    link.connect()
    expect(browser.ports).toHaveLength(1)
  })

  test("routes a host command frame to onCommand", () => {
    const { browser, link, commands } = setup()
    link.connect()
    const frame = hostCommand("cmd-1", "ping")
    livePort(browser).emitMessage(frame)
    expect(commands).toHaveLength(1)
    expect(commands[0]?.command).toEqual(frame)
  })

  test("ignores frames that are neither commands nor known replies", () => {
    const { browser, link, commands } = setup()
    link.connect()
    livePort(browser).emitMessage({ hello: "world" })
    livePort(browser).emitMessage({ id: "unknown", success: true, result: 1 })
    expect(commands).toEqual([])
    expect(livePort(browser).posted).toEqual([])
  })
})

describe("NativeLink reply", () => {
  test("posts the response frame with a boolean success", () => {
    const { browser, link, commands } = setup()
    link.connect()
    livePort(browser).emitMessage(hostCommand("cmd-1", "ping"))
    commands[0]?.reply({ id: "cmd-1", success: true, result: { pong: true } })
    expect(livePort(browser).posted).toEqual([
      { id: "cmd-1", success: true, result: { pong: true } },
    ])
  })

  test("posts an error response frame", () => {
    const { browser, link, commands } = setup()
    link.connect()
    livePort(browser).emitMessage(hostCommand("cmd-1", "nope"))
    commands[0]?.reply({ id: "cmd-1", success: false, error: "UNKNOWN_COMMAND: nope" })
    expect(livePort(browser).posted).toEqual([
      { id: "cmd-1", success: false, error: "UNKNOWN_COMMAND: nope" },
    ])
  })

  test("drops a late reply whose port disconnected before it arrived", () => {
    const { browser, env, link, commands } = setup()
    link.connect()
    const first = livePort(browser)
    first.emitMessage(hostCommand("cmd-1", "ping"))
    first.disconnect("native host has exited")
    env.advance(RECONNECT.initialDelayMs)
    const second = livePort(browser)
    expect(second).not.toBe(first)

    commands[0]?.reply({ id: "cmd-1", success: true, result: { pong: true } })
    expect(second.posted).toEqual([])
    expect(first.posted).toEqual([])
  })
})

describe("NativeLink.send", () => {
  test("posts an extension request and resolves on the matching id", async () => {
    const { browser, link } = setup()
    link.connect()
    const pending = link.send("version")
    expect(livePort(browser).posted).toEqual([{ id: "uuid-1", command: "version" }])

    livePort(browser).emitMessage({ id: "uuid-1", success: true, result: { host: "0.1.0" } })
    await expect(pending).resolves.toEqual({ host: "0.1.0" })
  })

  test("ignores a reply for an unknown id and keeps the request pending", async () => {
    const { browser, env, link } = setup()
    link.connect()
    const pending = link.send("ping")
    livePort(browser).emitMessage({ id: "other", success: true, result: null })
    livePort(browser).emitMessage({ id: "uuid-1", success: true, result: { pong: true } })
    await expect(pending).resolves.toEqual({ pong: true })
    expect(env.pendingTimers()).toBe(0)
  })

  test("rejects on a failure reply", async () => {
    const { browser, link } = setup()
    link.connect()
    const pending = link.send("ping")
    livePort(browser).emitMessage({ id: "uuid-1", success: false, error: "boom" })
    await expect(pending).rejects.toThrow("boom")
  })

  test("rejects after the default timeout and clears the timer on reply", async () => {
    const { env, link } = setup()
    link.connect()
    const pending = link.send("ping")
    env.advance(TIMEOUT_MS)
    await expect(pending).rejects.toThrow(`Request timed out after ${TIMEOUT_MS}ms (command: ping)`)
  })

  test("honours a custom timeout", async () => {
    const { env, link } = setup()
    link.connect()
    const pending = link.send("ping", 5000)
    env.advance(4999)
    env.advance(1)
    await expect(pending).rejects.toThrow("Request timed out after 5000ms (command: ping)")
  })

  test("rejects when the link is not connected", async () => {
    const { link } = setup()
    await expect(link.send("ping")).rejects.toThrow("Not connected to native host")
  })

  test("rejects and clears the timer when postMessage throws synchronously", async () => {
    const { browser, env, link } = setup()
    link.connect()
    livePort(browser).disconnected = true // makes postMessage throw without notifying onDisconnect
    const timersBeforeSend = env.pendingTimers() // the connection's stability timer
    const pending = link.send("ping")
    await expect(pending).rejects.toThrow(
      "Failed to send ping: Attempt to postMessage on disconnected port",
    )
    expect(env.pendingTimers()).toBe(timersBeforeSend)
  })
})

describe("NativeLink disconnect", () => {
  test("rejects pending requests with the port error text and clears their timers", async () => {
    const { browser, env, link } = setup()
    link.connect()
    const pending = link.send("ping")
    livePort(browser).disconnect("native host has exited")
    await expect(pending).rejects.toThrow("Native host disconnected: native host has exited")
    expect(env.pendingTimers()).toBe(1) // only the reconnect timer survives
    expect(link.status().connected).toBe(false)
    expect(link.status().lastDisconnectReason).toBe("native host has exited")
  })

  test("falls back to a generic reason when the port carries no error", () => {
    const { browser, link } = setup()
    link.connect()
    livePort(browser).disconnect()
    expect(link.status().lastDisconnectReason).toBe("Unknown disconnect reason")
  })

  test("ignores a disconnect from a port that was already replaced", () => {
    const { browser, env, link } = setup()
    link.connect()
    const first = livePort(browser)
    first.disconnect("first")
    env.advance(RECONNECT.initialDelayMs)
    expect(link.status().connected).toBe(true)

    for (const listener of first.onDisconnect.snapshot()) {
      listener(first)
    }
    expect(link.status().connected).toBe(true)
    expect(link.status().reconnectScheduled).toBe(false)
  })
})

describe("NativeLink reconnect", () => {
  test("schedules a reconnect when connectNative throws synchronously", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "No such native application firefox-ctl"
    link.connect()
    expect(link.status()).toEqual({
      connected: false,
      attempt: 1,
      lastDisconnectReason: null,
      reconnectScheduled: true,
    })

    browser.failConnect = undefined
    env.advance(RECONNECT.initialDelayMs)
    expect(link.status().connected).toBe(true)
    expect(browser.connectedHosts).toEqual(["firefoxctl", "firefoxctl"])
  })

  test("keeps a single pending timer when a disconnect races the retry", () => {
    const { browser, env, link } = setup()
    link.connect()
    livePort(browser).disconnect("gone")
    expect(env.pendingTimers()).toBe(1)
    livePort(browser).disconnect("gone again")
    expect(env.pendingTimers()).toBe(1)
    expect(link.status().attempt).toBe(1)
  })

  test("backs off exponentially, caps the delay and stops after the last attempt", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "No such native application firefox-ctl"
    link.connect()

    // 1000 * 1.5^n, the tenth one capped at maxDelayMs
    const delays = [
      1000, 1500, 2250, 3375, 5062.5, 7593.75, 11390.625, 17085.9375, 25628.90625, 30000,
    ]
    delays.forEach((delay, index) => {
      expect(browser.connectedHosts).toHaveLength(index + 1)
      expect(link.status().attempt).toBe(index + 1)
      env.advance(delay - 1)
      expect(browser.connectedHosts).toHaveLength(index + 1)
      env.advance(1)
      expect(browser.connectedHosts).toHaveLength(index + 2)
    })

    // the link gave up and reset the counter, waiting for an explicit connect
    expect(link.status()).toEqual({
      connected: false,
      attempt: 0,
      lastDisconnectReason: null,
      reconnectScheduled: false,
    })
  })

  test("reconnects again after an explicit connect following a giving up", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "nope"
    link.connect()
    for (let i = 0; i < RECONNECT.maxAttempts; i++) {
      env.advance(RECONNECT.maxDelayMs)
    }
    expect(link.status().reconnectScheduled).toBe(false)

    link.connect()
    expect(link.status().attempt).toBe(1)
    expect(link.status().reconnectScheduled).toBe(true)
  })

  test("resets the attempt counter once a connection stays up", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "nope"
    link.connect()
    browser.failConnect = undefined
    env.advance(RECONNECT.initialDelayMs)
    expect(link.status().attempt).toBe(1)

    env.advance(RECONNECT.stableAfterMs)
    expect(link.status().attempt).toBe(0)
  })

  test("resets the attempt counter on the first frame of a fresh connection", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "nope"
    link.connect()
    browser.failConnect = undefined
    env.advance(RECONNECT.initialDelayMs)

    livePort(browser).emitMessage(hostCommand("cmd-1", "ping"))
    expect(link.status().attempt).toBe(0)
    expect(env.pendingTimers()).toBe(0)
  })

  test("keeps the attempt counter when the connection drops before it is stable", () => {
    const { browser, env, link } = setup()
    browser.failConnect = "nope"
    link.connect()
    browser.failConnect = undefined
    env.advance(RECONNECT.initialDelayMs)
    livePort(browser).disconnect("gone")
    expect(link.status().attempt).toBe(2)
  })
})
