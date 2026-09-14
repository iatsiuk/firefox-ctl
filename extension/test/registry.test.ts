import { describe, expect, test } from "bun:test"

import type { ActionMap } from "../src/content/registry"
import { handleAction } from "../src/content/registry"
import { fakePage } from "./dom"
import errors from "./fixtures/errors.json"

const actions: ActionMap = {
  echo: (params) => ({ got: params }),
  title: (_params, page) => page.document.title,
  slow: async (params, page) => {
    await new Promise<void>((resolve) => page.setTimeout(resolve, 50))
    return { waited: params.ms ?? null }
  },
  boom: () => {
    throw new Error("BOOM: it broke")
  },
  reject: () => Promise.reject(new Error("rejected")),
  throwString: () => {
    throw "plain string"
  },
}

describe("handleAction", () => {
  test("wraps a result in a success response", async () => {
    await expect(
      handleAction(actions, fakePage(), { action: "echo", params: { a: 1 } }),
    ).resolves.toEqual({ success: true, result: { got: { a: 1 } } })
  })

  test("passes the injected page to the action", async () => {
    document.title = "Fixture"
    await expect(handleAction(actions, fakePage(), { action: "title" })).resolves.toEqual({
      success: true,
      result: "Fixture",
    })
  })

  test("awaits an asynchronous action", async () => {
    const page = fakePage()
    const pending = handleAction(actions, page, { action: "slow", params: { ms: 50 } })
    await page.advance(100)
    await expect(pending).resolves.toEqual({ success: true, result: { waited: 50 } })
  })

  test("defaults missing params to an empty object", async () => {
    await expect(handleAction(actions, fakePage(), { action: "echo" })).resolves.toEqual({
      success: true,
      result: { got: {} },
    })
  })

  test("rejects params that are not a plain object", async () => {
    const page = fakePage()
    for (const params of [null, 7, "x", true, [1, 2]]) {
      const message = { action: "echo", params } as unknown as {
        action: string
        params?: Record<string, never>
      }
      await expect(handleAction(actions, page, message)).resolves.toEqual({
        success: false,
        error: errors.paramsNotObject,
      })
    }
  })

  test("checks params before running the action", async () => {
    const calls: unknown[] = []
    const map: ActionMap = {
      count: (params) => {
        calls.push(params)
        return null
      },
    }
    const message = { action: "count", params: 7 } as unknown as { action: string }
    await handleAction(map, fakePage(), message)
    expect(calls).toHaveLength(0)
  })

  test("reports an unknown action", async () => {
    await expect(handleAction(actions, fakePage(), { action: "teleport" })).resolves.toEqual({
      success: false,
      error: errors.unknownAction.replace("<name>", "teleport"),
    })
  })

  test("rejects inherited Object.prototype properties as actions", async () => {
    for (const action of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      await expect(handleAction(actions, fakePage(), { action })).resolves.toEqual({
        success: false,
        error: errors.unknownAction.replace("<name>", action),
      })
    }
  })

  test("turns a thrown error into a failure reply, keeping the prefix", async () => {
    await expect(handleAction(actions, fakePage(), { action: "boom" })).resolves.toEqual({
      success: false,
      error: "BOOM: it broke",
    })
  })

  test("turns a rejected promise into a failure reply", async () => {
    await expect(handleAction(actions, fakePage(), { action: "reject" })).resolves.toEqual({
      success: false,
      error: "rejected",
    })
  })

  test("stringifies a thrown non-error", async () => {
    await expect(handleAction(actions, fakePage(), { action: "throwString" })).resolves.toEqual({
      success: false,
      error: "plain string",
    })
  })
})
