import { describe, expect, test } from "bun:test"

import { pageActions, startPage } from "../src/page"
import { fakePage } from "./dom"
import { FakeBrowser } from "./fakes"
import errors from "./fixtures/errors.json"

describe("startPage", () => {
  test("answers tabs.sendMessage with a promise carrying the action result", async () => {
    const browser = new FakeBrowser()
    startPage(browser, fakePage(), { ping: () => ({ pong: true }) })

    expect(browser.runtimeMessages.listeners).toHaveLength(1)
    const answer = browser.runtimeMessages.listeners[0]?.({ action: "ping" }, {})
    expect(answer).toBeInstanceOf(Promise)
    await expect(answer).resolves.toEqual({ success: true, result: { pong: true } })
  })

  test("answers an action it does not know", async () => {
    const browser = new FakeBrowser()
    startPage(browser, fakePage(), {})
    await expect(browser.emitRuntimeMessage({ action: "type" })).resolves.toEqual({
      success: false,
      error: errors.unknownAction.replace("<name>", "type"),
    })
  })

  test("leaves messages without a string action to other listeners", async () => {
    const browser = new FakeBrowser()
    startPage(browser, fakePage(), {})
    for (const message of [{ params: {} }, { action: 7 }, "hello", null]) {
      expect(await browser.emitRuntimeMessage(message)).toBeUndefined()
    }
  })

  test("registers the shared action map by default", async () => {
    const browser = new FakeBrowser()
    startPage(browser, fakePage())
    const answer = await browser.emitRuntimeMessage({ action: "definitelyNotAnAction" })
    expect(answer).toEqual({
      success: false,
      error: errors.unknownAction.replace("<name>", "definitelyNotAnAction"),
    })
  })
})

describe("pageActions", () => {
  test("is the registry the content script exposes to the background page", () => {
    expect(typeof pageActions).toBe("object")
  })
})
