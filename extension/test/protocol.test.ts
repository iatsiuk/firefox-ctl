import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type {
  CommandName,
  ExtensionRequest,
  ExtensionResponse,
  HostCommand,
  HostReply,
  JsonObject,
} from "../src/protocol"
import {
  COMMANDS,
  ERROR_CODES,
  ExtensionError,
  isCommandName,
  isHostCommand,
  requestBudgetMs,
  TYPE_COMMAND,
} from "../src/protocol"

const fixtures = `${import.meta.dir}/fixtures`

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(`${fixtures}/${name}.json`).text()) as unknown
}

// walks up from the extension directory to the repository root, the first
// directory holding cli/go.mod
function repoRoot(): string | undefined {
  let dir = resolve(import.meta.dir, "..")
  for (;;) {
    if (existsSync(join(dir, "cli", "go.mod"))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

describe("commands.json", () => {
  test("holds the same command table as the Go fixture", async () => {
    const root = repoRoot()
    if (root === undefined) {
      console.warn("skipping: no cli/go.mod above the extension directory")
      return
    }
    const goFixture = join(root, "cli", "internal", "protocol", "testdata", "commands.json")
    const go = JSON.parse(await Bun.file(goFixture).text()) as unknown
    const ours = JSON.parse(await Bun.file(`${import.meta.dir}/../src/commands.json`).text())
    expect(ours).toEqual(go)
  })

  test("COMMANDS lists all 30 command names in fixture order", () => {
    expect(COMMANDS.length).toBe(30)
    expect(COMMANDS[0]).toBe("ping")
    expect(COMMANDS[1]).toBe("version")
    expect(COMMANDS).toContain("getNetworkRequests")
    expect(new Set(COMMANDS).size).toBe(COMMANDS.length)
  })

  test("the CommandName union and COMMANDS hold the same names", () => {
    // fails to compile when a name is added to the union without the table
    const union: Record<CommandName, true> = {
      ping: true,
      version: true,
      createWindow: true,
      navigate: true,
      canNavigate: true,
      getWindowMode: true,
      getActiveTab: true,
      getTabs: true,
      listAllTabs: true,
      attachTab: true,
      detachTab: true,
      closeTab: true,
      closeWindow: true,
      getWindows: true,
      resizeWindow: true,
      setViewport: true,
      getContent: true,
      click: true,
      type: true,
      pressKey: true,
      scroll: true,
      waitFor: true,
      screenshot: true,
      handleConsent: true,
      getPageState: true,
      getAccessibilitySnapshot: true,
      getElementInfo: true,
      evaluate: true,
      getConsoleLogs: true,
      getNetworkRequests: true,
    }
    expect(Object.keys(union).sort()).toEqual([...COMMANDS].sort())
  })

  test("isCommandName accepts known names and rejects anything else", () => {
    expect(isCommandName("evaluate")).toBe(true)
    expect(isCommandName("nope")).toBe(false)
    expect(isCommandName(7)).toBe(false)
    expect(isCommandName(undefined)).toBe(false)
  })
})

describe("isHostCommand", () => {
  test("accepts a host command frame", async () => {
    const frame = await fixture("host-command")
    expect(isHostCommand(frame)).toBe(true)
    if (!isHostCommand(frame)) {
      throw new Error("unreachable")
    }
    const cmd: HostCommand = frame
    expect(cmd.id).toBe("3f2a")
    expect(cmd.type).toBe(TYPE_COMMAND)
    expect(cmd.command).toBe("navigate")
    expect(cmd.params.url).toBe("https://example.com")
  })

  test("accepts a frame with empty params", async () => {
    expect(isHostCommand(await fixture("host-command-empty-params"))).toBe(true)
  })

  test("rejects responses, replies and malformed frames", async () => {
    expect(isHostCommand(await fixture("extension-response-success"))).toBe(false)
    expect(isHostCommand(await fixture("extension-response-error"))).toBe(false)
    expect(isHostCommand(await fixture("host-reply"))).toBe(false)
    expect(isHostCommand(await fixture("extension-request"))).toBe(false)
    expect(isHostCommand({ id: "1", type: "event", command: "ping", params: {} })).toBe(false)
    expect(isHostCommand({ id: 1, type: "command", command: "ping", params: {} })).toBe(false)
    expect(isHostCommand({ id: "1", type: "command", params: {} })).toBe(false)
    expect(isHostCommand({ id: "1", type: "command", command: "ping", params: null })).toBe(false)
    expect(isHostCommand({ id: "1", type: "command", command: "ping", params: [] })).toBe(false)
    expect(isHostCommand(null)).toBe(false)
    expect(isHostCommand("command")).toBe(false)
  })
})

describe("frame shapes", () => {
  test("a success response carries a boolean success and a result", async () => {
    const frame = (await fixture("extension-response-success")) as ExtensionResponse
    expect(frame.success).toBe(true)
    if (!frame.success) {
      throw new Error("unreachable")
    }
    expect(frame.result).toEqual({ pong: true, timestamp: 1757635200000 })
  })

  test("an error response carries a boolean success and the prefixed text", async () => {
    const frame = (await fixture("extension-response-error")) as ExtensionResponse
    expect(frame.success).toBe(false)
    if (frame.success) {
      throw new Error("unreachable")
    }
    expect(frame.error).toBe("TAB_CLOSED: tab 7 was closed")
  })

  test("an extension request carries only an id and a command", async () => {
    const frame = (await fixture("extension-request")) as ExtensionRequest
    expect(Object.keys(frame).sort()).toEqual(["command", "id"])
    expect(frame.command).toBe("version")
  })

  test("a host reply carries the result of an extension request", async () => {
    const frame = (await fixture("host-reply")) as HostReply
    expect(frame.success).toBe(true)
    expect(frame.result).toEqual({
      host: "0.1.0",
      go: "go1.25.1",
      platform: "darwin",
    })
  })
})

describe("ExtensionError", () => {
  test("prefixes the message with the code", () => {
    const err = new ExtensionError("TAB_CLOSED", "tab 7 was closed")
    expect(err.message).toBe("TAB_CLOSED: tab 7 was closed")
    expect(err.code).toBe("TAB_CLOSED")
    expect(err.name).toBe("ExtensionError")
    expect(err instanceof Error).toBe(true)
    expect(err instanceof ExtensionError).toBe(true)
  })

  test("covers every prefix documented in docs/commands.md plus UNKNOWN_COMMAND", () => {
    expect([...ERROR_CODES]).toEqual([
      "TAB_CLOSED",
      "TAB_UNAVAILABLE",
      "NO_TABS",
      "MODE_MISMATCH",
      "RESTRICTED_PAGE",
      "PAGE_LOAD_FAILED",
      "CONTENT_SCRIPT_UNAVAILABLE",
      "CONTENT_SCRIPT_ERROR",
      "UNKNOWN_COMMAND",
      "COMMAND_TIMEOUT",
      "SCREENSHOT_TOO_LARGE",
      "EVALUATE_DISABLED",
    ])
    for (const code of ERROR_CODES) {
      expect(new ExtensionError(code, "text").message).toBe(`${code}: text`)
    }
  })

  test("survives the throw and catch path with errors.Is-style narrowing", () => {
    try {
      throw new ExtensionError("UNKNOWN_COMMAND", "frobnicate")
    } catch (err) {
      expect(err instanceof ExtensionError).toBe(true)
      expect((err as ExtensionError).code).toBe("UNKNOWN_COMMAND")
      expect(String(err)).toBe("ExtensionError: UNKNOWN_COMMAND: frobnicate")
    }
  })
})

describe("requestBudgetMs", () => {
  // the host clamps and truncates the same way in `timeoutMs`/`asInt`, and the
  // extension answers 1000 ms before the host gives up on the command
  test.each([
    ["absent", {}, 149000],
    ["at the minimum", { _timeout: 5000 }, 4000],
    ["at the maximum", { _timeout: 300000 }, 299000],
    ["inside the range", { _timeout: 30000 }, 29000],
    ["fractional inside the range", { _timeout: 5000.9 }, 4000],
    ["fractional below the minimum", { _timeout: 4999.9 }, 149000],
    ["below the minimum", { _timeout: 4999 }, 149000],
    ["above the maximum", { _timeout: 300001 }, 149000],
    ["negative", { _timeout: -1 }, 149000],
    ["not a number", { _timeout: "30000" }, 149000],
    ["null", { _timeout: null }, 149000],
  ])("%s", (_name, params, expected) => {
    expect(requestBudgetMs(params as JsonObject)).toBe(expected)
  })
})
