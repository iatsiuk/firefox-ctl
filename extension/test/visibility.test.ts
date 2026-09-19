import { beforeEach, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import { isDisplayNone } from "../src/content/visibility"
import { fakePage, stubRect, stubStyle } from "./dom"

function el(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found
}

function mount(html: string): Page {
  document.body.innerHTML = html
  return fakePage()
}

beforeEach(() => {
  document.body.innerHTML = ""
})

test("a plain element is not display: none", () => {
  const page = mount('<div id="wrap"><p id="p">Hello</p></div>')
  expect(isDisplayNone(page, el("#p"))).toBe(false)
})

test("the element's own display: none counts", () => {
  const page = mount('<p id="p">Hello</p>')
  stubStyle(el("#p"), { display: "none" })
  expect(isDisplayNone(page, el("#p"))).toBe(true)
})

test("an ancestor's display: none counts", () => {
  const page = mount('<section id="box"><div><p id="p">Hello</p></div></section>')
  stubStyle(el("#box"), { display: "none" })
  expect(isDisplayNone(page, el("#p"))).toBe(true)
})

test("visibility: hidden does not count: the box is still laid out", () => {
  const page = mount('<section id="box"><p id="p">Hello</p></section>')
  stubStyle(el("#box"), { visibility: "hidden" })
  stubStyle(el("#p"), { visibility: "hidden" })
  expect(isDisplayNone(page, el("#p"))).toBe(false)
})

test("a zero box does not count: positioned children may still show", () => {
  const page = mount('<section id="box"><p id="p">Hello</p></section>')
  stubRect(el("#box"), { width: 0, height: 0 })
  stubRect(el("#p"), { width: 0, height: 0 })
  expect(isDisplayNone(page, el("#p"))).toBe(false)
})

test("display: contents does not count, on the element or an ancestor", () => {
  const page = mount('<section id="box"><div id="wrap"><p id="p">Hello</p></div></section>')
  stubStyle(el("#wrap"), { display: "contents" })
  expect(isDisplayNone(page, el("#wrap"))).toBe(false)
  expect(isDisplayNone(page, el("#p"))).toBe(false)
})

test("the document's own body and root element are not display: none", () => {
  const page = mount("<p>Hello</p>")
  expect(isDisplayNone(page, document.body)).toBe(false)
  expect(isDisplayNone(page, document.documentElement)).toBe(false)
})
