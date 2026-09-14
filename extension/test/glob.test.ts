import { describe, expect, test } from "bun:test"

import { globToRegExp } from "../src/glob"

describe("globToRegExp", () => {
  test("anchors the pattern at both ends", () => {
    const pattern = globToRegExp("https://example.com/docs")

    expect(pattern.test("https://example.com/docs")).toBe(true)
    expect(pattern.test("https://example.com/docs/intro")).toBe(false)
    expect(pattern.test("x https://example.com/docs")).toBe(false)
  })

  test("treats * as the only wildcard", () => {
    const pattern = globToRegExp("https://example.com/docs/*")

    expect(pattern.test("https://example.com/docs/intro")).toBe(true)
    expect(pattern.test("https://example.com/docs/")).toBe(true)
    expect(pattern.test("https://example.org/docs/intro")).toBe(false)
  })

  test("escapes dots, question marks and other metacharacters", () => {
    const pattern = globToRegExp("https://example.com/search?q=1")

    expect(pattern.test("https://example.com/search?q=1")).toBe(true)
    expect(pattern.test("https://examplexcom/search?q=1")).toBe(false)
    expect(pattern.test("https://example.com/searchq=1")).toBe(false)
  })

  test("keeps regex groups literal", () => {
    const pattern = globToRegExp("https://example.com/(a|b)+[c]")

    expect(pattern.test("https://example.com/(a|b)+[c]")).toBe(true)
    expect(pattern.test("https://example.com/a")).toBe(false)
  })
})
