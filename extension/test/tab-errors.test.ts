import { describe, expect, test } from "bun:test"
import { ExtensionError } from "../src/protocol"
import { describeTabError, isContentScriptMissing } from "../src/tab-errors"
import { FakeBrowser } from "./fakes"

const RECEIVING_END = "Could not establish connection. Receiving end does not exist."
const TAB_ID = 16
const FRAME_ID = 7

function browserWithTab(url: string): FakeBrowser {
  return new FakeBrowser({
    tabs: [{ id: TAB_ID, windowId: 1, url, title: "Checkout", status: "complete" }],
    windows: [{ id: 1, focused: true }],
  })
}

describe("isContentScriptMissing", () => {
  test("recognizes the coded error describeTabError produces", () => {
    const error = new ExtensionError("CONTENT_SCRIPT_UNAVAILABLE", "Cannot communicate with tab 1.")

    expect(isContentScriptMissing(error)).toBe(true)
  })

  test("rejects a differently coded ExtensionError", () => {
    const error = new ExtensionError("TAB_CLOSED", "Tab 1 no longer exists.")

    expect(isContentScriptMissing(error)).toBe(false)
  })

  test("recognizes Firefox's raw message when it bypasses describeTabError", () => {
    const error = new Error("Could not establish connection. Receiving end does not exist.")

    expect(isContentScriptMissing(error)).toBe(true)
  })

  test("rejects an unrelated raw error", () => {
    expect(isContentScriptMissing(new Error("Permission denied"))).toBe(false)
  })
})

describe("describeTabError in a child frame", () => {
  test("turns a missing receiver into FRAME_NOT_OBSERVED for that frame", async () => {
    const browser = browserWithTab("https://stage.overgear.in/checkout")

    const error = await describeTabError(browser, TAB_ID, new Error(RECEIVING_END), FRAME_ID)

    expect(error.message).toBe(
      "FRAME_NOT_OBSERVED: frame 7 of tab 16 is not observed; " +
        "call watchFrames before the frame loads or reopen it",
    )
  })

  test("says nothing about the top document, whatever state it is in", async () => {
    const browser = browserWithTab("about:config")

    const error = await describeTabError(browser, TAB_ID, new Error(RECEIVING_END), FRAME_ID)

    expect(error.message).toMatch(/^FRAME_NOT_OBSERVED: /)
  })

  test("reports a tab that is gone as TAB_CLOSED even for a frame", async () => {
    const browser = browserWithTab("https://stage.overgear.in/checkout")
    await browser.tabs.remove(TAB_ID)

    const error = await describeTabError(browser, TAB_ID, new Error(RECEIVING_END), FRAME_ID)

    expect(error.message).toMatch(/^TAB_CLOSED: /)
  })

  test("keeps the top classification for frame 0", async () => {
    const browser = browserWithTab("about:config")

    const error = await describeTabError(browser, TAB_ID, new Error(RECEIVING_END))

    expect(error.message).toMatch(/^RESTRICTED_PAGE: /)
  })

  test("leaves an unrelated failure untouched in a frame", async () => {
    const browser = browserWithTab("https://stage.overgear.in/checkout")

    const error = await describeTabError(browser, TAB_ID, new Error("boom"), FRAME_ID)

    expect(error.message).toBe("boom")
  })
})
