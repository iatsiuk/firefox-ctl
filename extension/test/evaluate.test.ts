import { beforeEach, describe, expect, test } from "bun:test"

import { evaluate } from "../src/content/evaluate"
import type { JsonObject } from "../src/protocol"
import { fakePage } from "./dom"

beforeEach(() => {
  document.title = "Evaluate page"
  document.body.innerHTML = ""
})

function result(value: unknown): JsonObject {
  return value as JsonObject
}

describe("evaluate", () => {
  test("returns a primitive with its type", () => {
    expect(result(evaluate({ expression: "1 + 1" }, fakePage()))).toEqual({
      expression: "1 + 1",
      result: 2,
      type: "number",
    })
  })

  test("returns a JSON round-tripped object", () => {
    const value = result(evaluate({ expression: "({a: 1, b: [true, null]})" }, fakePage()))
    expect(value.result).toEqual({ a: 1, b: [true, null] })
    expect(value.type).toBe("object")
  })

  test("reads the document of the page it runs in", () => {
    document.title = "Evaluate page"
    const value = result(evaluate({ expression: "document.title" }, fakePage()))
    expect(value.result).toBe("Evaluate page")
    expect(value.type).toBe("string")
  })

  test("stringifies a non-serialisable result", () => {
    const value = result(evaluate({ expression: "(function pick() {})" }, fakePage()))
    expect(value.type).toBe("function")
    expect(String(value.result)).toContain("function pick")
  })

  test("stringifies undefined", () => {
    const value = result(evaluate({ expression: "undefined" }, fakePage()))
    expect(value).toEqual({ expression: "undefined", result: "undefined", type: "undefined" })
  })

  test("reports a thrown expression as a successful reply", () => {
    const value = result(evaluate({ expression: "missingFunction()" }, fakePage()))
    expect(value.expression).toBe("missingFunction()")
    expect(value.type).toBe("error")
    expect(String(value.error)).toContain("missingFunction")
  })

  test("reports a syntax error as a successful reply", () => {
    const value = result(evaluate({ expression: "1 +" }, fakePage()))
    expect(value.type).toBe("error")
    expect(typeof value.error).toBe("string")
  })

  test("requires an expression", () => {
    expect(() => evaluate({}, fakePage())).toThrow("expression is required")
    expect(() => evaluate({ expression: "" }, fakePage())).toThrow("expression is required")
    expect(() => evaluate({ expression: 7 }, fakePage())).toThrow("expression is required")
  })

  test("has no length cap and no blocklist", () => {
    const long = `"${"a".repeat(20000)}"`
    expect(result(evaluate({ expression: long }, fakePage())).type).toBe("string")
    expect(result(evaluate({ expression: "typeof localStorage" }, fakePage())).type).toBe("string")
  })
})
