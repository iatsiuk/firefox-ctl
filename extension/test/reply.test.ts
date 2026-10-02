import { describe, expect, test } from "bun:test"
import { ENVELOPE_ID, replyBytes, utf8Length } from "../src/reply"

describe("utf8Length", () => {
  test.each([
    ["", 0],
    ["ascii", 5],
    ["Привет", 12],
    ["€", 3],
    ["😀", 4],
    ["a b", 5],
    ["\ud800", 3],
    ["\udc00x", 4],
    ["\ud83d", 3],
  ])("%p is %p bytes, as TextEncoder counts them", (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes)
    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length)
  })
})

describe("replyBytes", () => {
  test("measures the success envelope the dispatcher sends", () => {
    const result = { text: "<a & b>", n: 1, name: "Привет" }
    const frame = JSON.stringify({ id: ENVELOPE_ID, success: true, result })
    expect(replyBytes(result)).toBe(new TextEncoder().encode(frame).length)
  })

  test("the envelope id is as long as a host command id", () => {
    expect(ENVELOPE_ID).toHaveLength(36)
  })
})
