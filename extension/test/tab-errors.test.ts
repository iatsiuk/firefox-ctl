import { describe, expect, test } from "bun:test"
import { ExtensionError } from "../src/protocol"
import { isContentScriptMissing } from "../src/tab-errors"

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
