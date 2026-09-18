// The read-only page actions: content extraction, element details, the page
// summary and the accessibility snapshot, with their result shapes and limits.
// `getPageState.errors` reports what console capture has recorded.

import type { JsonObject, JsonValue } from "../protocol"
import { capturedErrors } from "./console"
import type { Page } from "./page"
import { safeQuerySelector } from "./selector"
import { buildElementNotFoundError } from "./suggest"
import { SelectorUnavailable, uniqueSelector } from "./unique-selector"
import { isRendered } from "./visibility"

const truncationSuffix = "\n\n[... truncated, use selector for specific content]"

const DEFAULT_MAX_LENGTH = 50000
const ELEMENT_TEXT_LIMIT = 500
const A11Y_TEXT_LIMIT = 100
const A11Y_VALUE_LIMIT = 50
const A11Y_CHILD_LIMIT = 50

/** The properties an action reads off form controls, links and images. */
type FieldLike = Element & {
  value?: string
  disabled?: boolean
  checked?: boolean
  required?: boolean
  type?: string
  name?: string
  placeholder?: string
  alt?: string
  src?: string
  href?: string
  labels?: ArrayLike<Element> | null
}

function field(element: Element): FieldLike {
  return element as FieldLike
}

function numberParam(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function textOf(element: Element): string {
  return element.textContent?.trim() ?? ""
}

/** A box with a non-zero area; the only visibility test the read actions apply. */
function hasBox(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function requireElement(page: Page, selector: JsonValue | undefined): Element {
  const element = safeQuerySelector(page, selector)
  if (!element) {
    throw new Error(`Element not found: ${String(selector)}`)
  }
  return element
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, limit) + truncationSuffix, truncated: true }
}

export function getContent(params: JsonObject, page: Page): JsonValue {
  const includeHtml = params.includeHtml === true
  const maxLength = numberParam(params.maxLength, DEFAULT_MAX_LENGTH)

  if (params.selector) {
    const element = requireElement(page, params.selector)
    const raw = textOf(element)
    const { text, truncated } = truncateText(raw, maxLength)
    const result: JsonObject = {
      selector: params.selector,
      text,
      tagName: element.tagName.toLowerCase(),
      textLength: raw.length,
      truncated,
    }
    if (includeHtml) {
      result.html = element.innerHTML
    }
    return result
  }

  const body = page.document.body
  const raw = body === null ? "" : textOf(body)
  const { text, truncated } = truncateText(raw, maxLength)
  const result: JsonObject = {
    url: page.window.location.href,
    title: page.document.title,
    text,
    textLength: raw.length,
    truncated,
  }
  if (includeHtml) {
    result.html = page.document.documentElement.outerHTML
  }
  return result
}

export function getElementInfo(params: JsonObject, page: Page): JsonValue {
  // unlike getContent, a miss here reports near-miss selectors and page context
  const element = safeQuerySelector(page, params.selector)
  if (!element) {
    throw buildElementNotFoundError(page, String(params.selector), "getElementInfo")
  }
  const rect = element.getBoundingClientRect()
  const styles = page.window.getComputedStyle(element)

  const attributes: JsonObject = {}
  for (const attribute of element.attributes) {
    attributes[attribute.name] = attribute.value
  }

  return {
    selector: params.selector ?? null,
    tagName: element.tagName.toLowerCase(),
    attributes,
    text: textOf(element).slice(0, ELEMENT_TEXT_LIMIT),
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      styles.display !== "none" &&
      styles.visibility !== "hidden",
    position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles: {
      display: styles.display,
      visibility: styles.visibility,
      opacity: styles.opacity,
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontSize: styles.fontSize,
    },
  }
}

const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]'

const LANDMARK_SELECTOR =
  '[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], ' +
  '[role="search"], [role="form"], main, nav, header, footer, aside'

function collectHeadings(page: Page): JsonObject[] {
  const headings: JsonObject[] = []
  for (const element of page.document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const text = textOf(element)
    if (text) {
      headings.push({ level: element.tagName.toLowerCase(), text: text.slice(0, 100) })
    }
  }
  return headings
}

/** An entry and the element it describes, kept until the slice picks winners. */
interface Found {
  entry: JsonObject
  element: Element
}

function collectLinks(page: Page): Found[] {
  const links: Found[] = []
  for (const element of page.document.querySelectorAll("a[href]")) {
    if (!hasBox(element)) {
      continue
    }
    const text = textOf(element) || element.getAttribute("aria-label") || ""
    if (text) {
      links.push({
        element,
        entry: {
          text: text.slice(0, 50),
          href: element.getAttribute("href")?.slice(0, 100) ?? null,
        },
      })
    }
  }
  return links
}

function collectButtons(page: Page): Found[] {
  const buttons: Found[] = []
  for (const element of page.document.querySelectorAll(BUTTON_SELECTOR)) {
    if (!hasBox(element)) {
      continue
    }
    const control = field(element)
    const text = textOf(element) || control.value || element.getAttribute("aria-label") || ""
    buttons.push({
      element,
      entry: {
        text: text.slice(0, 50),
        disabled: control.disabled === true || element.getAttribute("aria-disabled") === "true",
        type: control.type || "button",
      },
    })
  }
  return buttons
}

function labelOf(page: Page, control: FieldLike): string {
  const explicit = control.getAttribute("aria-label") || control.placeholder
  if (explicit) {
    return explicit
  }
  if (!control.id) {
    return ""
  }
  // scanned rather than queried by `[for="<id>"]`: an id can contain a quote,
  // which would otherwise turn into an invalid or wrong selector
  for (const label of page.document.querySelectorAll("label[for]")) {
    if (label.getAttribute("for") === control.id) {
      return textOf(label)
    }
  }
  return ""
}

function collectInputs(page: Page): Found[] {
  const inputs: Found[] = []
  for (const element of page.document.querySelectorAll("input, textarea, select")) {
    const control = field(element)
    if (control.type === "hidden" || !hasBox(element)) {
      continue
    }
    inputs.push({
      element,
      entry: {
        type: control.type || element.tagName.toLowerCase(),
        name: control.name || element.id || "",
        label: labelOf(page, control),
        value: control.type === "password" ? "***" : (control.value?.slice(0, 50) ?? ""),
        required: control.required === true,
        disabled: control.disabled === true,
      },
    })
  }
  return inputs
}

function collectImages(page: Page): JsonObject[] {
  const images: JsonObject[] = []
  for (const element of page.document.querySelectorAll("img[alt]")) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 20 && rect.height > 20) {
      const image = field(element)
      images.push({ alt: (image.alt ?? "").slice(0, 100), src: image.src?.slice(0, 100) ?? null })
    }
  }
  return images
}

function collectLandmarks(page: Page): JsonObject[] {
  const landmarks: JsonObject[] = []
  for (const element of page.document.querySelectorAll(LANDMARK_SELECTOR)) {
    landmarks.push({
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      label: element.getAttribute("aria-label") || "",
    })
  }
  return landmarks
}

function count(items: unknown[], max: number): JsonObject {
  return { shown: Math.min(items.length, max), total: items.length }
}

// the slice runs first: a dropped entry never costs a selector query
function described(page: Page, found: Found[], max: number): JsonObject[] {
  return found.slice(0, max).map(({ entry, element }) => {
    try {
      return { ...entry, selector: uniqueSelector(page, element) }
    } catch (error) {
      if (error instanceof SelectorUnavailable) {
        return { ...entry, selector: null }
      }
      throw error
    }
  })
}

export function getPageState(params: JsonObject, page: Page): JsonValue {
  const maxHeadings = numberParam(params.maxHeadings, 30)
  const maxLinks = numberParam(params.maxLinks, 50)
  const maxButtons = numberParam(params.maxButtons, 30)
  const maxInputs = numberParam(params.maxInputs, 30)
  const maxImages = numberParam(params.maxImages, 20)

  const headings = collectHeadings(page)
  const links = collectLinks(page)
  const buttons = collectButtons(page)
  const inputs = collectInputs(page)
  const images = collectImages(page)
  const landmarks = collectLandmarks(page)

  return {
    url: page.window.location.href,
    title: page.document.title,
    viewport: {
      width: page.window.innerWidth,
      height: page.window.innerHeight,
      scrollX: page.window.scrollX,
      scrollY: page.window.scrollY,
      scrollHeight: page.document.documentElement.scrollHeight,
    },
    // only what console capture has seen; empty until the first getConsoleLogs
    errors: capturedErrors(),
    headings: headings.slice(0, maxHeadings),
    links: described(page, links, maxLinks),
    buttons: described(page, buttons, maxButtons),
    inputs: described(page, inputs, maxInputs),
    images: images.slice(0, maxImages),
    landmarks,
    counts: {
      headings: count(headings, maxHeadings),
      links: count(links, maxLinks),
      buttons: count(buttons, maxButtons),
      inputs: count(inputs, maxInputs),
      images: count(images, maxImages),
      landmarks: count(landmarks, landmarks.length),
    },
  }
}

const IMPLICIT_ROLES: Record<string, string> = {
  button: "button",
  select: "combobox",
  textarea: "textbox",
  img: "img",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
}

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  submit: "button",
}

function accessibleName(page: Page, element: Element): string {
  const control = field(element)
  const labelledBy = element.getAttribute("aria-labelledby")
  const referenced = labelledBy === null ? null : page.document.getElementById(labelledBy)
  const label = control.labels?.[0]
  return (
    element.getAttribute("aria-label") ||
    (referenced === null ? "" : textOf(referenced)) ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    (element.tagName === "INPUT" ? (control.placeholder ?? "") : "") ||
    (element.tagName === "IMG" ? (control.alt ?? "") : "") ||
    (label === undefined ? "" : textOf(label)) ||
    ""
  )
}

function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role")
  if (explicit) {
    return explicit
  }
  const tag = element.tagName.toLowerCase()
  if (tag === "a") {
    return field(element).href ? "link" : null
  }
  if (tag === "input") {
    return INPUT_ROLES[field(element).type ?? ""] ?? "textbox"
  }
  return IMPLICIT_ROLES[tag] ?? null
}

/** A div, span or p carrying no semantics is skipped but its children are not. */
function isTransparent(element: Element, role: string | null, name: string, text: string): boolean {
  return !role && !name && !text && /^(DIV|SPAN|P)$/i.test(element.tagName)
}

/** The trimmed text of an element whose only child is a text node. */
function ownText(element: Element): string {
  const only = element.childNodes.length === 1 ? element.childNodes[0] : undefined
  return only?.nodeType === 3 ? textOf(element).slice(0, A11Y_TEXT_LIMIT) : ""
}

function stateOf(element: Element, node: JsonObject): void {
  const control = field(element)
  if (control.disabled === true) {
    node.disabled = true
  }
  if (control.checked === true) {
    node.checked = true
  }
  const expanded = element.getAttribute("aria-expanded")
  if (expanded) {
    node.expanded = expanded === "true"
  }
  const selected = element.getAttribute("aria-selected")
  if (selected) {
    node.selected = selected === "true"
  }
  if (
    control.value &&
    /^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName) &&
    control.type !== "password"
  ) {
    node.value = control.value.slice(0, A11Y_VALUE_LIMIT)
  }
}

interface Walk {
  page: Page
  root: Element
  maxDepth: number
  maxNodes: number
  nodeCount: number
  truncated: boolean
}

function walkTree(walk: Walk, element: Element, depth: number): JsonObject | null {
  if (depth > walk.maxDepth) {
    return null
  }
  if (walk.nodeCount >= walk.maxNodes) {
    walk.truncated = true
    return null
  }
  if (!isRendered(walk.page, element) && element !== walk.root) {
    return null
  }

  const role = roleOf(element)
  const name = accessibleName(walk.page, element)
  const text = ownText(element)

  if (isTransparent(element, role, name, text)) {
    const collapsed = walkChildren(walk, element, depth)
    if (collapsed.length === 1) {
      return collapsed[0] ?? null
    }
    return collapsed.length > 1 ? { children: collapsed } : null
  }

  // counted before the children are visited, so nodes the child cap later drops
  // still show up in nodeCount
  walk.nodeCount++

  const node: JsonObject = {}
  if (role) {
    node.role = role
  }
  if (name) {
    node.name = name
  }
  if (text) {
    node.text = text
  }
  stateOf(element, node)

  const children = walkChildren(walk, element, depth + 1)
  if (children.length > 0) {
    node.children = children.slice(0, A11Y_CHILD_LIMIT)
  }
  return Object.keys(node).length > 0 ? node : null
}

function walkChildren(walk: Walk, element: Element, depth: number): JsonObject[] {
  const children: JsonObject[] = []
  for (const child of element.children) {
    const node = walkTree(walk, child, depth)
    if (node) {
      children.push(node)
    }
  }
  return children
}

export function getAccessibilitySnapshot(params: JsonObject, page: Page): JsonValue {
  const selector = params.selector ?? "body"
  const maxDepth = numberParam(params.maxDepth, 5)
  const maxNodes = numberParam(params.maxNodes, 200)
  // the default root needs no validation; any other selector does
  const root = selector === "body" ? page.document.body : safeQuerySelector(page, selector)
  if (!root) {
    throw new Error(`Element not found: ${String(selector)}`)
  }

  const walk: Walk = { page, root, maxDepth, maxNodes, nodeCount: 0, truncated: false }
  const tree = walkTree(walk, root, 0)

  return {
    url: page.window.location.href,
    title: page.document.title,
    tree,
    nodeCount: walk.nodeCount,
    maxNodes,
    truncated: walk.truncated,
  }
}
