// The content-script composition root, on both sides of the injection: the top
// document answers tab messages, a child frame of a watched tab additionally
// opens the port the background admits it on and goes silent once that port is
// deactivated or closed. Every case runs on a window of its own, because the
// per-document guard would otherwise leak from one test into the next.

import { describe, expect, test } from "bun:test"

import { DEACTIVATE_MESSAGE, FRAME_PORT_NAME } from "../src/frame-port"
import { pageActions, startPage } from "../src/page"
import { childWindow, type FakePage, fakePage, isolatedWindow } from "./dom"
import { FakeBrowser, type FakePort } from "./fakes"
import errors from "./fixtures/errors.json"

// not in fixtures/errors.json yet: FRAME_NOT_OBSERVED joins the declared error
// codes with the frame commands, and the fixture suite pins only declared ones
const DEACTIVATED = "FRAME_NOT_OBSERVED: frame is deactivated; call watchFrames and reload it"

interface Side {
  browser: FakeBrowser
  page: FakePage
  doc: Document
}

function side(isTop: boolean): Side {
  const { win, doc } = isolatedWindow(isTop)
  return { browser: new FakeBrowser(), page: fakePage(doc, win), doc }
}

function framePort(browser: FakeBrowser): FakePort {
  const port = browser.connectedPorts[0]
  if (!port) {
    throw new Error("the frame side opened no port")
  }
  return port
}

describe("startPage", () => {
  test("answers tabs.sendMessage with a promise carrying the action result", async () => {
    const { browser, page } = side(true)
    startPage(browser, page, { ping: () => ({ pong: true }) })

    expect(browser.runtimeMessages.listeners).toHaveLength(1)
    const answer = browser.runtimeMessages.listeners[0]?.({ action: "ping" }, {})
    expect(answer).toBeInstanceOf(Promise)
    await expect(answer).resolves.toEqual({ success: true, result: { pong: true } })
  })

  test("answers an action it does not know", async () => {
    const { browser, page } = side(true)
    startPage(browser, page, {})
    await expect(browser.emitRuntimeMessage({ action: "type" })).resolves.toEqual({
      success: false,
      error: errors.unknownAction.replace("<name>", "type"),
    })
  })

  test("leaves messages without a string action to other listeners", async () => {
    const { browser, page } = side(true)
    startPage(browser, page, {})
    for (const message of [{ params: {} }, { action: 7 }, "hello", null]) {
      expect(await browser.emitRuntimeMessage(message)).toBeUndefined()
    }
  })

  test("registers the shared action map by default", async () => {
    const { browser, page } = side(true)
    startPage(browser, page)
    const answer = await browser.emitRuntimeMessage({ action: "definitelyNotAnAction" })
    expect(answer).toEqual({
      success: false,
      error: errors.unknownAction.replace("<name>", "definitelyNotAnAction"),
    })
  })
})

describe("startPage in a child frame", () => {
  test("connects to the background and answers actions", async () => {
    const { browser, page } = side(false)
    startPage(browser, page, { ping: () => ({ pong: true }) })

    expect(browser.connectedPorts).toHaveLength(1)
    expect(framePort(browser).name).toBe(FRAME_PORT_NAME)
    await expect(browser.emitRuntimeMessage({ action: "ping" })).resolves.toEqual({
      success: true,
      result: { pong: true },
    })
  })

  test("the top document opens no port", () => {
    const { browser, page } = side(true)
    startPage(browser, page, { ping: () => true })
    expect(browser.connectedPorts).toHaveLength(0)
  })

  test("a second injection into the same document adds no listener and no port", async () => {
    const { win, doc } = childWindow()
    const first = new FakeBrowser()
    startPage(first, fakePage(doc, win), { ping: () => ({ pong: 1 }) })

    const second = new FakeBrowser()
    startPage(second, fakePage(doc, win), { ping: () => ({ pong: 2 }) })

    expect(second.runtimeMessages.listeners).toHaveLength(0)
    expect(second.connectedPorts).toHaveLength(0)
    expect(first.runtimeMessages.listeners).toHaveLength(1)
    await expect(first.emitRuntimeMessage({ action: "ping" })).resolves.toEqual({
      success: true,
      result: { pong: 1 },
    })
  })

  for (const [name, end] of [
    ["the background deactivates it", (port: FakePort) => port.emitMessage(DEACTIVATE_MESSAGE)],
    ["its port disconnects", (port: FakePort) => port.disconnect()],
  ] as const) {
    test(`refuses every action once ${name}`, async () => {
      const { browser, page } = side(false)
      let calls = 0
      startPage(browser, page, {
        ping: () => {
          calls++
          return true
        },
      })
      await expect(browser.emitRuntimeMessage({ action: "ping" })).resolves.toEqual({
        success: true,
        result: true,
      })

      end(framePort(browser))

      await expect(browser.emitRuntimeMessage({ action: "ping" })).resolves.toEqual({
        success: false,
        error: DEACTIVATED,
      })
      expect(calls).toBe(1)
    })
  }

  test("replaces the reply of an action in flight when deactivation arrives", async () => {
    const { browser, page, doc } = side(false)
    startPage(browser, page)

    const answer = browser.emitRuntimeMessage({
      action: "type",
      params: { selector: "#late", text: "4111", waitTimeout: 1000 },
    })
    await page.advance(200)
    framePort(browser).emitMessage(DEACTIVATE_MESSAGE)
    await page.advance(1200)

    await expect(answer).resolves.toEqual({ success: false, error: DEACTIVATED })

    // the frame is silent, so a target that shows up afterwards is never typed into
    doc.body.innerHTML = '<input id="late">'
    await page.advance(1000)
    expect(doc.querySelector<HTMLInputElement>("#late")?.value).toBe("")
  })
})

describe("pageActions", () => {
  test("is the registry the content script exposes to the background page", () => {
    expect(typeof pageActions).toBe("object")
  })
})
