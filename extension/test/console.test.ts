import { afterEach, describe, expect, test } from "bun:test"

import {
  capturedErrors,
  getConsoleLogs,
  MAX_LOGS,
  resetConsoleCapture,
} from "../src/content/console"
import { getPageState } from "../src/content/read"
import type { JsonValue } from "../src/protocol"
import { childWindow, type FakePage, fakePage, isolatedWindow } from "./dom"
import logsFixture from "./fixtures/results/getConsoleLogs.json"

interface LogsResult {
  logs: { level: string; timestamp: number; message: string }[]
  total: number
  filtered: number
  captureEnabled: boolean
  scope: string
}

function logs(params: Record<string, JsonValue> = {}, page: FakePage): LogsResult {
  return getConsoleLogs(params, page) as unknown as LogsResult
}

/** A page whose capture is already running, as after the first getConsoleLogs. */
function capturing(page: FakePage = fakePage()): FakePage {
  getConsoleLogs({}, page)
  return page
}

/** A content side of its own: one window, one document, one capture. */
function sidePage(isTop = true): FakePage {
  const { win, doc } = isTop ? isolatedWindow() : childWindow()
  return fakePage(doc, win)
}

function messages(result: LogsResult): string[] {
  return result.logs.map((entry) => entry.message)
}

afterEach(() => {
  resetConsoleCapture(fakePage())
})

describe("console capture", () => {
  test("the first call enables capture and reports its scope", () => {
    const page = fakePage()

    expect(logs({}, page)).toEqual({
      logs: [],
      total: 0,
      filtered: 0,
      captureEnabled: true,
      scope: "content-world",
    })
  })

  test("keeps nothing logged before the first call", () => {
    const page = fakePage()
    page.console.log("early")

    expect(logs({}, page).logs).toEqual([])
    expect(page.consoleCalls).toEqual([{ level: "log", args: ["early"] }])
  })

  test("records every level and still calls the original", () => {
    const page = capturing()

    page.console.log("a")
    page.console.warn("b")
    page.console.error("c")
    page.console.info("d")
    page.console.debug("e")

    expect(logs({}, page).logs).toEqual([
      { level: "log", timestamp: 0, message: "a" },
      { level: "warn", timestamp: 0, message: "b" },
      { level: "error", timestamp: 0, message: "c" },
      { level: "info", timestamp: 0, message: "d" },
      { level: "debug", timestamp: 0, message: "e" },
    ])
    expect(page.consoleCalls.map((call) => call.level)).toEqual([
      "log",
      "warn",
      "error",
      "info",
      "debug",
    ])
  })

  test("stamps entries with the page clock", async () => {
    const page = capturing()
    await page.advance(120)

    page.console.log("late")

    expect(logs({}, page).logs[0]?.timestamp).toBe(120)
  })

  test("serialises objects as indented JSON and joins the arguments", () => {
    const page = capturing()

    page.console.log("value", { a: 1 }, 2, null, undefined)

    expect(messages(logs({}, page))).toEqual(['value {\n  "a": 1\n} 2 null undefined'])
  })

  test("reports an argument that cannot be serialised", () => {
    const page = capturing()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    page.console.log(cyclic)

    expect(messages(logs({}, page))).toEqual(["[Unserializable]"])
  })

  test("captures an uncaught page error", () => {
    const page = capturing()

    page.window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 4, colno: 9 }),
    )

    expect(logs({}, page).logs).toEqual([
      { level: "error", timestamp: 0, message: "Uncaught Error: boom at app.js:4:9" },
    ])
  })

  test("captures an unhandled rejection", () => {
    const page = capturing()

    page.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "nope" }))

    expect(messages(logs({}, page))).toEqual(["Unhandled Promise Rejection: nope"])
  })

  test("drops the oldest entry once the ring is full", () => {
    const page = capturing()
    for (let i = 0; i < MAX_LOGS + 3; i++) {
      page.console.log(`entry ${i}`)
    }

    const result = logs({ limit: MAX_LOGS }, page)
    expect(result.total).toBe(MAX_LOGS)
    expect(result.logs[0]?.message).toBe("entry 3")
    expect(result.logs.at(-1)?.message).toBe(`entry ${MAX_LOGS + 2}`)
  })

  test("filters by level", () => {
    const page = capturing()
    page.console.log("a")
    page.console.error("b")
    page.console.error("c")

    expect(logs({ level: "error" }, page)).toEqual({
      logs: [
        { level: "error", timestamp: 0, message: "b" },
        { level: "error", timestamp: 0, message: "c" },
      ],
      total: 3,
      filtered: 2,
      captureEnabled: true,
      scope: "content-world",
    })
  })

  test("keeps the newest entries within the limit", () => {
    const page = capturing()
    page.console.log("a")
    page.console.log("b")
    page.console.log("c")

    expect(messages(logs({ limit: 2 }, page))).toEqual(["b", "c"])
  })

  test("limit 0 keeps the newest zero entries instead of the whole buffer", () => {
    const page = capturing()
    page.console.log("a")
    page.console.log("b")

    const result = logs({ limit: 0 }, page)

    expect(result.logs).toEqual([])
    expect(result.filtered).toBe(0)
    expect(result.total).toBe(2)
  })

  test("defaults to the newest hundred entries", () => {
    const page = capturing()
    for (let i = 0; i < 120; i++) {
      page.console.log(`entry ${i}`)
    }

    const result = logs({}, page)
    expect(result.filtered).toBe(100)
    expect(result.logs[0]?.message).toBe("entry 20")
    expect(result.total).toBe(120)
  })

  test("clear returns the old entries and empties the buffer", () => {
    const page = capturing()
    page.console.log("a")
    page.console.warn("b")

    const cleared = logs({ clear: true }, page)
    expect(messages(cleared)).toEqual(["a", "b"])
    expect(cleared).toMatchObject({ total: 0, filtered: 2 })
    expect(logs({}, page)).toMatchObject({ logs: [], total: 0, filtered: 0 })
  })

  test("matches the pinned result", async () => {
    const page = capturing()
    page.console.log("hello", { a: 1 })
    await page.advance(25)
    page.console.error("boom")

    expect(logs({}, page)).toEqual(logsFixture as unknown as LogsResult)
  })

  test("a second call does not wrap the console twice", () => {
    const page = capturing()
    getConsoleLogs({}, page)

    page.console.log("once")

    expect(logs({}, page).logs).toHaveLength(1)
    expect(page.consoleCalls).toHaveLength(1)
  })
})

describe("one capture per document", () => {
  test("two content sides keep independent buffers", () => {
    const top = capturing(sidePage(true))
    const child = capturing(sidePage(false))

    top.console.log("from the top")
    child.console.log("from the frame")

    expect(messages(logs({}, top))).toEqual(["from the top"])
    expect(messages(logs({}, child))).toEqual(["from the frame"])
  })

  test("resetting one document leaves the other capturing", () => {
    const top = capturing(sidePage(true))
    const child = capturing(sidePage(false))
    top.console.log("from the top")

    resetConsoleCapture(child)
    top.console.log("still here")

    expect(messages(logs({}, top))).toEqual(["from the top", "still here"])
    expect(logs({}, child).logs).toEqual([])
  })

  test("a second injection into one document shares the capture of the first", () => {
    const { win, doc } = childWindow()
    const first = capturing(fakePage(doc, win))
    first.console.log("from the first injection")

    const second = fakePage(doc, win)

    // the second bundle finds the capture already running and wraps nothing
    expect(messages(logs({}, second))).toEqual(["from the first injection"])
    first.console.log("again")
    expect(first.consoleCalls).toHaveLength(2)
    expect(logs({}, first).logs).toHaveLength(2)
  })

  test("a reset takes the error and rejection listeners off the window", () => {
    const page = capturing()

    resetConsoleCapture(page)
    page.window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 4, colno: 9 }),
    )
    page.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "nope" }))
    page.console.log("after the reset")

    // the console is the page's own again: nothing was recorded before the
    // next getConsoleLogs enabled a fresh capture
    expect(logs({}, page).logs).toEqual([])
    expect(page.consoleCalls).toEqual([{ level: "log", args: ["after the reset"] }])
  })
})

describe("captured errors", () => {
  test("are empty before capture is enabled", () => {
    expect(capturedErrors(fakePage())).toEqual([])
  })

  test("are the messages of the last ten error entries", () => {
    const page = capturing()
    page.console.log("ignored")
    for (let i = 0; i < 12; i++) {
      page.console.error(`boom ${i}`)
    }

    expect(capturedErrors(page)).toEqual([
      "boom 2",
      "boom 3",
      "boom 4",
      "boom 5",
      "boom 6",
      "boom 7",
      "boom 8",
      "boom 9",
      "boom 10",
      "boom 11",
    ])
  })
})

describe("getPageState errors", () => {
  test("are empty while nothing has been captured", () => {
    document.body.innerHTML = "<h1>Hi</h1>"

    expect((getPageState({}, fakePage()) as unknown as { errors: string[] }).errors).toEqual([])
  })

  test("report the captured error messages", () => {
    document.body.innerHTML = "<h1>Hi</h1>"
    const page = capturing()
    page.console.error("first")
    page.console.warn("not an error")
    page.window.dispatchEvent(
      new ErrorEvent("error", { message: "second", filename: "a.js", lineno: 1, colno: 2 }),
    )

    expect((getPageState({}, page) as unknown as { errors: string[] }).errors).toEqual([
      "first",
      "Uncaught Error: second at a.js:1:2",
    ])
  })
})
