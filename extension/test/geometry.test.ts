import { describe, expect, test } from "bun:test"

import { DEVICES } from "../src/devices"
import {
  canNavigate,
  createWindow,
  getWindowMode,
  getWindows,
  resizeWindow,
  setViewport,
  type WindowDeps,
} from "../src/handlers/window"
import type { JsonObject } from "../src/protocol"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import modeFixture from "./fixtures/results/getWindowMode.json"
import windowsFixture from "./fixtures/results/getWindows.json"
import resizeFixture from "./fixtures/results/resizeWindow.json"
import viewportFixture from "./fixtures/results/setViewport.json"

interface Harness {
  browser: FakeBrowser
  session: Session
  deps: WindowDeps
  open(params?: JsonObject): Promise<JsonObject>
}

function harness(browser = new FakeBrowser()): Harness {
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  session.attach()
  const deps: WindowDeps = { browser, env, session }
  return {
    browser,
    session,
    deps,
    open: async (params: JsonObject = {}) => (await createWindow(params, deps)) as JsonObject,
  }
}

describe("getWindows", () => {
  test("lists every window with its mode, focus and tab count", async () => {
    const h = harness(
      new FakeBrowser({
        windows: [
          { id: 1, focused: true },
          { id: 2, incognito: true },
        ],
        tabs: [
          { id: 1, windowId: 1 },
          { id: 2, windowId: 1 },
          { id: 3, windowId: 2 },
        ],
      }),
    )

    expect(await getWindows({}, h.deps)).toEqual(windowsFixture)
  })

  test("reports an empty list when Firefox has no windows", async () => {
    const h = harness()

    expect(await getWindows({}, h.deps)).toEqual([])
  })
})

describe("resizeWindow", () => {
  test("updates only the provided fields and matches the fixture", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    const result = await resizeWindow({ windowId: 1, width: 1024, height: 768 }, h.deps)

    expect(result).toEqual(resizeFixture)
    const window = await h.browser.windows.get(1)
    expect(window.left).toBe(0)
    expect(window.top).toBe(0)
  })

  test("moves a window without resizing it", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    const result = await resizeWindow({ windowId: 1, left: 40, top: 25 }, h.deps)

    expect(result).toEqual({ windowId: 1, width: 1280, height: 800, left: 40, top: 25 })
  })

  test("targets the session window when no windowId is given", async () => {
    const h = harness()
    const opened = await h.open()

    const result = (await resizeWindow({ width: 900 }, h.deps)) as JsonObject

    expect(result.windowId).toBe(opened.windowId as number)
    expect(result.width).toBe(900)
  })

  test("fails without a session and without a windowId", async () => {
    const h = harness()

    expect(resizeWindow({ width: 900 }, h.deps)).rejects.toThrow(errors.sessionLost)
  })

  test("rejects a windowId that is not a positive integer", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    expect(resizeWindow({ windowId: 0 }, h.deps)).rejects.toThrow(errors.invalidWindowId)
    expect(resizeWindow({ windowId: "1" }, h.deps)).rejects.toThrow(errors.invalidWindowId)
  })

  test("propagates a Firefox error for an unknown window", async () => {
    const h = harness()

    expect(resizeWindow({ windowId: 99, width: 900 }, h.deps)).rejects.toThrow("Invalid window ID")
  })
})

describe("setViewport", () => {
  test("applies a device preset to the session window and matches the fixture", async () => {
    const h = harness()
    const opened = await h.open()

    const result = (await setViewport({ device: "iphone-14" }, h.deps)) as JsonObject

    expect(result).toEqual({ ...viewportFixture })
    const window = await h.browser.windows.get(opened.windowId as number)
    expect(window.width).toBe(390)
    expect(window.height).toBe(924)
  })

  test("supports every preset in the device table", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    for (const [device, preset] of Object.entries(DEVICES)) {
      const result = (await setViewport({ windowId: 1, device }, h.deps)) as JsonObject

      expect(result.device).toBe(device)
      expect(result.viewport).toEqual({ width: preset.width, height: preset.height })
      expect(result.window).toEqual({ width: preset.width, height: preset.height + 80 })
      expect(result.type).toBe(preset.type)
    }
  })

  test("classifies custom sizes at the 768 and 1024 boundaries", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))
    const cases: [number, string][] = [
      [767, "mobile"],
      [768, "tablet"],
      [1023, "tablet"],
      [1024, "desktop"],
    ]

    for (const [width, type] of cases) {
      const result = (await setViewport({ windowId: 1, width, height: 600 }, h.deps)) as JsonObject

      expect(result.device).toBe("custom")
      expect(result.type).toBe(type)
      expect(result.viewport).toEqual({ width, height: 600 })
      expect(result.window).toEqual({ width, height: 680 })
    }
  })

  test("lists the presets when neither a device nor a size is given", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    expect(setViewport({ windowId: 1 }, h.deps)).rejects.toThrow(errors.viewportMissingParams)
  })

  test("treats an unknown device and a half-given size as missing params", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1 }] }))

    expect(setViewport({ windowId: 1, device: "nokia-3310" }, h.deps)).rejects.toThrow(
      errors.viewportMissingParams,
    )
    expect(setViewport({ windowId: 1, width: 400 }, h.deps)).rejects.toThrow(
      errors.viewportMissingParams,
    )
  })

  test("fails without a session and without a windowId", async () => {
    const h = harness()

    expect(setViewport({ device: "laptop" }, h.deps)).rejects.toThrow(errors.sessionLost)
  })
})

describe("mode queries", () => {
  test("canNavigate reports the private-window permission", async () => {
    const h = harness()

    expect(await canNavigate({}, h.deps)).toEqual({ canNavigate: true })
  })

  test("canNavigate reports a revoked permission", async () => {
    const h = harness(new FakeBrowser({ allowedIncognitoAccess: false }))

    expect(await canNavigate({}, h.deps)).toEqual({ canNavigate: false })
  })

  test("getWindowMode describes a private session and matches the fixture", async () => {
    const h = harness()
    await h.open()

    expect(await getWindowMode({}, h.deps)).toEqual(modeFixture)
  })

  test("getWindowMode reports a normal session", async () => {
    const h = harness(new FakeBrowser({ windows: [{ id: 1, focused: true }] }))
    await h.open({ private: false })

    expect(await getWindowMode({}, h.deps)).toEqual({
      privateWindowsAvailable: true,
      currentWindowMode: "normal",
      windowExists: true,
    })
  })

  test("getWindowMode reports no session", async () => {
    const h = harness(new FakeBrowser({ allowedIncognitoAccess: false }))

    expect(await getWindowMode({}, h.deps)).toEqual({
      privateWindowsAvailable: false,
      currentWindowMode: null,
      windowExists: false,
    })
  })
})
