import { describe, expect, spyOn, test } from "bun:test"
import type { HttpHeader, RequestBody } from "../src/browser"
import {
  buildLog,
  fitLog,
  type Har,
  type HarEntry,
  type HarPostData,
  type HarRecording,
  type HopRecord,
  harHeaders,
  httpVersion,
  postData,
  queryString,
  redactEntry,
  requestBodySize,
  requestCookies,
  responseContent,
  responseCookies,
  responseSizes,
  statusText,
  timings,
} from "../src/har"
import { replyBytes } from "../src/reply"

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0)

function bytes(text: string): ArrayBuffer {
  const view = new TextEncoder().encode(text)
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

function buffer(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function ct(value: string): HttpHeader[] {
  return [{ name: "Content-Type", value }]
}

describe("harHeaders", () => {
  test("keeps order, case and duplicates", () => {
    const headers: HttpHeader[] = [
      { name: "Accept", value: "*/*" },
      { name: "x-Trace", value: "1" },
      { name: "x-Trace", value: "2" },
    ]
    expect(harHeaders(headers)).toEqual([
      { name: "Accept", value: "*/*" },
      { name: "x-Trace", value: "1" },
      { name: "x-Trace", value: "2" },
    ])
  })

  test("decodes binaryValue as Latin-1", () => {
    expect(harHeaders([{ name: "X-Bin", binaryValue: [0x41, 0xe9, 0xff] }])).toEqual([
      { name: "X-Bin", value: "Aéÿ" },
    ])
  })

  test("a header without value or binaryValue becomes an empty value", () => {
    expect(harHeaders([{ name: "X-Empty" }])).toEqual([{ name: "X-Empty", value: "" }])
  })

  test("no headers give an empty list", () => {
    expect(harHeaders(undefined)).toEqual([])
  })
})

describe("requestCookies", () => {
  test.each([
    [
      "a=1; b=2",
      [
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ],
    ],
    [
      "a=1;b=x=y",
      [
        { name: "a", value: "1" },
        { name: "b", value: "x=y" },
      ],
    ],
    ["  a = 1 ;; ", [{ name: "a", value: "1" }]],
    ["solo", [{ name: "", value: "solo" }]],
    ["", []],
  ])("%p", (header, cookies) => {
    expect(requestCookies(header)).toEqual(cookies)
  })
})

describe("responseCookies", () => {
  test("parses every attribute of one cookie", () => {
    const header =
      "sid=abc; Path=/app; Domain=.example.com; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax"
    expect(responseCookies([header])).toEqual([
      {
        name: "sid",
        value: "abc",
        path: "/app",
        domain: ".example.com",
        expires: "2015-10-21T07:28:00.000Z",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ])
  })

  test("one cookie per Set-Cookie header", () => {
    expect(responseCookies(["a=1; Path=/", "b=2"])).toEqual([
      { name: "a", value: "1", path: "/" },
      { name: "b", value: "2" },
    ])
  })

  test("Set-Cookie headers Firefox joined with newlines are split again", () => {
    expect(responseCookies(["a=1\nb=2; Secure"])).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2", secure: true },
    ])
  })

  test("a malformed cookie keeps what parses", () => {
    expect(responseCookies(["broken; Expires=not a date; Path=/x; =; Max-Age"])).toEqual([
      { name: "", value: "broken", path: "/x" },
    ])
  })
})

describe("queryString", () => {
  test.each([
    ["https://e.com/", []],
    ["https://e.com/?", []],
    [
      "https://e.com/?a=1&a=2&b",
      [
        { name: "a", value: "1" },
        { name: "a", value: "2" },
        { name: "b", value: "" },
      ],
    ],
    [
      "https://e.com/?q=hello+world&x=%D0%B6%20y#frag",
      [
        { name: "q", value: "hello world" },
        { name: "x", value: "ж y" },
      ],
    ],
    [
      "https://e.com/?bad=%E0%A4%A&ok=1",
      [
        { name: "bad", value: "%E0%A4%A" },
        { name: "ok", value: "1" },
      ],
    ],
    ["https://e.com/?k%ZZ=v", [{ name: "k%ZZ", value: "v" }]],
    ["https://e.com/?a=1=2", [{ name: "a", value: "1=2" }]],
  ])("%p", (url, params) => {
    expect(queryString(url)).toEqual(params)
  })
})

describe("httpVersion and statusText", () => {
  test.each([
    ["HTTP/1.1 200 OK", "HTTP/1.1", "OK"],
    ["HTTP/2 200", "HTTP/2", ""],
    ["HTTP/3 200", "HTTP/3", ""],
    ["HTTP/1.1 404 Not Found", "HTTP/1.1", "Not Found"],
    ["HTTP/1.0 301 Moved Permanently", "HTTP/1.0", "Moved Permanently"],
    ["", "", ""],
    [undefined, "", ""],
    ["garbage", "", ""],
  ])("%p", (line, version, text) => {
    expect(httpVersion(line)).toBe(version)
    expect(statusText(line)).toBe(text)
  })
})

describe("postData", () => {
  test("raw bytes become text decoded as UTF-8 without a charset", () => {
    expect(postData({ raw: [{ bytes: bytes('{"a":"ж"}') }] }, "application/json", 100)).toEqual({
      mimeType: "application/json",
      text: '{"a":"ж"}',
    })
  })

  test("raw bytes are decoded with the Content-Type charset", () => {
    const body: RequestBody = { raw: [{ bytes: buffer([0xcf, 0xf0, 0xe8]) }] }
    expect(postData(body, "text/plain; charset=windows-1251", 100)).toEqual({
      mimeType: "text/plain; charset=windows-1251",
      text: "При",
    })
  })

  test.each([
    ["bytes that are not UTF-8", "application/octet-stream"],
    ["an unknown charset", "text/plain; charset=x-nonsense"],
  ])("%s give base64", (_name, contentType) => {
    const body: RequestBody = { raw: [{ bytes: buffer([0xff, 0xfe, 0x41]) }] }
    expect(postData(body, contentType, 100)).toEqual({
      mimeType: contentType,
      text: "//5B",
      _encoding: "base64",
    })
  })

  test("several raw parts are concatenated", () => {
    const body: RequestBody = { raw: [{ bytes: bytes("ab") }, { bytes: bytes("cd") }] }
    expect(postData(body, "text/plain", 100)).toEqual({ mimeType: "text/plain", text: "abcd" })
  })

  test("a file part is only counted", () => {
    const body: RequestBody = {
      raw: [
        { bytes: bytes("head") },
        { file: "<file>" },
        { bytes: bytes("tail") },
        { file: "<file>" },
      ],
    }
    expect(postData(body, "text/plain", 100)).toEqual({
      mimeType: "text/plain",
      text: "headtail",
      _fileParts: 2,
    })
  })

  test("a part Firefox truncated is reported, apart from our own cut", () => {
    const body: RequestBody = {
      raw: [{ bytes: bytes("abc"), truncated: true, originalSize: 20000000 }],
    }
    expect(postData(body, "text/plain", 100)).toEqual({
      mimeType: "text/plain",
      text: "abc",
      _truncatedByBrowser: true,
      _originalSize: 20000000,
    })
    expect(postData(body, "text/plain", 2)).toEqual({
      mimeType: "text/plain",
      text: "ab",
      _truncated: true,
      _truncatedByBrowser: true,
      _originalSize: 20000000,
    })
  })

  test("raw bytes above maxBytes are cut inside the part that crosses it", () => {
    const body: RequestBody = {
      raw: [{ bytes: bytes("abc") }, { bytes: bytes("defg") }, { bytes: bytes("h") }],
    }
    expect(postData(body, "text/plain", 5)).toEqual({
      mimeType: "text/plain",
      text: "abcde",
      _truncated: true,
    })
    expect(postData(body, "text/plain", 8)).toEqual({ mimeType: "text/plain", text: "abcdefgh" })
  })

  test("formData gives params only", () => {
    const body: RequestBody = { formData: { a: ["1", "2"], b: ["x y"] } }
    expect(postData(body, "application/x-www-form-urlencoded", 100)).toEqual({
      mimeType: "application/x-www-form-urlencoded",
      params: [
        { name: "a", value: "1" },
        { name: "a", value: "2" },
        { name: "b", value: "x y" },
      ],
      _formData: true,
    })
  })

  test("multipart formData keeps its Content-Type and warns about file names", () => {
    const mime = "multipart/form-data; boundary=----x"
    const result = postData({ formData: { name: ["Ann"], upload: ["photo.png"] } }, mime, 100)
    expect(result.mimeType).toBe(mime)
    expect(result.text).toBeUndefined()
    expect(result.params).toEqual([
      { name: "name", value: "Ann" },
      { name: "upload", value: "photo.png" },
    ])
    expect(result._formData).toBe(true)
    expect(result.comment).toContain("file names")
  })

  test("formData over maxBytes, measured as UTF-8, cuts the params list", () => {
    const body: RequestBody = { formData: { a: ["12345"], b: ["678"] } }
    expect(postData(body, "application/x-www-form-urlencoded", 6)).toEqual({
      mimeType: "application/x-www-form-urlencoded",
      params: [{ name: "a", value: "12345" }],
      _formData: true,
      _truncated: true,
    })
    const wide: RequestBody = { formData: { ж: ["ж"] } }
    expect(postData(wide, "", 3).params).toEqual([])
    expect(postData(wide, "", 4).params).toEqual([{ name: "ж", value: "ж" }])
  })

  test("an error Firefox reports is kept", () => {
    expect(postData({ error: "Unsupported upload" }, "text/plain", 100)).toEqual({
      mimeType: "text/plain",
      text: "",
      _error: "Unsupported upload",
    })
  })

  test("without a Content-Type the mimeType is empty", () => {
    expect(postData({ raw: [{ bytes: bytes("x") }] }, "", 100).mimeType).toBe("")
  })
})

describe("responseContent", () => {
  const done = { complete: true }

  test.each([
    ["text/html; charset=utf-8"],
    ["text/plain"],
    ["application/json"],
    ["application/ld+json"],
    ["application/javascript"],
    ["text/javascript"],
    ["application/xml"],
    ["image/svg+xml"],
    ["application/x-www-form-urlencoded"],
  ])("%p is text", (mime) => {
    expect(responseContent(u8("<ж>"), ct(mime), done)).toEqual({
      size: 4,
      mimeType: mime,
      text: "<ж>",
    })
  })

  test("text is decoded with the Content-Type charset", () => {
    const body = new Uint8Array([0xcf, 0xf0, 0xe8])
    expect(responseContent(body, ct("text/html; charset=windows-1251"), done)).toEqual({
      size: 3,
      mimeType: "text/html; charset=windows-1251",
      text: "При",
    })
  })

  test("a textual body that does not decode becomes base64", () => {
    expect(responseContent(new Uint8Array([0xff, 0xfe]), ct("text/plain"), done)).toEqual({
      size: 2,
      mimeType: "text/plain",
      text: "//4=",
      encoding: "base64",
    })
  })

  test("a binary body is base64", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(responseContent(png, ct("image/png"), done)).toEqual({
      size: 4,
      mimeType: "image/png",
      text: "iVBORw==",
      encoding: "base64",
    })
  })

  test("a large binary body is encoded in full", () => {
    const body = new Uint8Array(100001).map((_, i) => i % 256)
    const content = responseContent(body, ct("application/octet-stream"), done)
    expect(content.text).toBe(Buffer.from(body).toString("base64"))
  })

  test("no Content-Type gives an empty mimeType and base64", () => {
    expect(responseContent(u8("hi"), [], done)).toEqual({
      size: 2,
      mimeType: "",
      text: "aGk=",
      encoding: "base64",
    })
  })

  test("an unfinished body is marked incomplete, with its markers passed through", () => {
    expect(
      responseContent(u8("ab"), ct("text/plain"), {
        complete: false,
        truncated: true,
        error: "boom",
      }),
    ).toEqual({
      size: 2,
      mimeType: "text/plain",
      text: "ab",
      _complete: false,
      _truncated: true,
      _bodyError: "boom",
    })
  })

  test("a body never captured has size 0 and no text", () => {
    expect(responseContent(undefined, ct("text/html"), done)).toEqual({
      size: 0,
      mimeType: "text/html",
    })
    expect(responseContent(undefined, ct("text/html"), { complete: true, dropped: true })).toEqual({
      size: 0,
      mimeType: "text/html",
      _bodyDropped: true,
    })
  })

  test("size counts the bytes seen when given", () => {
    expect(responseContent(u8("ab"), ct("text/plain"), { complete: false, size: 10 }).size).toBe(10)
  })
})

describe("requestBodySize", () => {
  const length = (value: string): HttpHeader[] => [{ name: "Content-Length", value }]
  const raw = (...parts: string[]): RequestBody => ({
    raw: parts.map((p) => ({ bytes: bytes(p) })),
  })

  test.each<[string, RequestBody | undefined, HttpHeader[], boolean, number]>([
    ["a valid Content-Length wins", raw("abc"), length("10"), true, 10],
    ["Content-Length without capture", undefined, length("42"), false, 42],
    ["an invalid Content-Length is ignored", raw("abc"), length("1e3"), true, 3],
    ["a negative Content-Length is ignored", raw("abc"), length("-1"), true, 3],
    ["captured raw parts are summed", raw("abc", "de"), [], true, 5],
    ["formData without a length", { formData: { a: ["1"] } }, [], true, -1],
    ["a GET with nothing to send", undefined, [], true, 0],
    ["capture not requested (maxBodySize 0)", undefined, [], false, -1],
    ["a streaming POST", undefined, [{ name: "Transfer-Encoding", value: "chunked" }], true, -1],
    ["a metadata-only POST", raw("abc"), [], false, -1],
    [
      "a multipart with a file part",
      { raw: [{ bytes: bytes("a") }, { file: "<file>" }] },
      [],
      true,
      -1,
    ],
    [
      "browser truncation in the second substream",
      { raw: [{ bytes: bytes("a") }, { bytes: bytes("b"), truncated: true, originalSize: 99 }] },
      [],
      true,
      -1,
    ],
    ["a body error", { error: "nope" }, [], true, -1],
  ])("%s", (_name, body, headers, captured, size) => {
    expect(requestBodySize(body, headers, captured)).toBe(size)
  })

  test("originalSize never becomes bodySize", () => {
    const body: RequestBody = { raw: [{ bytes: bytes("a"), truncated: true, originalSize: 99 }] }
    expect(requestBodySize(body, [], true)).toBe(-1)
  })

  test("conflicting Content-Length headers are not trusted", () => {
    const headers = [...length("3"), ...length("4")]
    expect(requestBodySize(raw("abc"), headers, true)).toBe(3)
  })
})

describe("responseSizes", () => {
  const length: HttpHeader[] = [{ name: "content-length", value: "120" }]
  const base = { method: "GET", status: 200, headers: length, complete: true, truncated: false }

  test.each([
    ["HEAD", { ...base, method: "HEAD" }, 0],
    ["1xx", { ...base, status: 101 }, 0],
    ["204", { ...base, status: 204 }, 0],
    ["304", { ...base, status: 304 }, 0],
    ["a completed body", base, 120],
    ["a truncated body", { ...base, truncated: true }, -1],
    ["an unfinished body", { ...base, complete: false }, -1],
    ["no Content-Length", { ...base, headers: [] }, -1],
  ])("%s", (_name, input, bodySize) => {
    expect(responseSizes(input)).toEqual({ bodySize, headersSize: -1 })
  })
})

describe("timings", () => {
  test("splits the stamps into HAR phases", () => {
    expect(timings({ start: 100, sendHeaders: 110, headersReceived: 150, end: 175 })).toEqual({
      time: 75,
      timings: { blocked: 10, dns: -1, connect: -1, ssl: -1, send: 0, wait: 40, receive: 25 },
    })
  })

  test("missing stamps degrade to 0", () => {
    expect(timings({ start: 100 })).toEqual({
      time: 0,
      timings: { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 },
    })
    expect(timings({ start: 100, headersReceived: 130, end: 140 })).toEqual({
      time: 40,
      timings: { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: 30, receive: 10 },
    })
  })

  test("stamps out of order never go negative", () => {
    const result = timings({ start: 100, sendHeaders: 90, headersReceived: 80, end: 70 })
    expect(result.timings).toEqual({
      blocked: 0,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: 0,
      receive: 0,
    })
    expect(result.time).toBe(0)
  })
})

function hop(overrides: Partial<HopRecord> = {}): HopRecord {
  return {
    requestId: "1",
    method: "GET",
    url: "https://example.com/",
    type: "main_frame",
    frameId: 0,
    start: T0,
    sendHeaders: T0 + 5,
    headersReceived: T0 + 20,
    end: T0 + 30,
    requestHeaders: [{ name: "Accept", value: "*/*" }],
    bodyCaptured: true,
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: [{ name: "Content-Type", value: "text/html" }],
    ip: "93.184.216.34",
    fromCache: false,
    ...overrides,
  }
}

function recording(overrides: Partial<HarRecording> = {}): HarRecording {
  return {
    tabId: 7,
    start: T0,
    maxBodySize: 10485760,
    creatorVersion: "1.2.3",
    tabClosed: false,
    pages: [{ id: "page_1", start: T0, title: "https://example.com/" }],
    hops: [],
    ...overrides,
  }
}

function only(har: Har): HarEntry {
  const entry = har.log.entries[0]
  if (entry === undefined) {
    throw new Error("no entry")
  }
  return entry
}

describe("redactEntry", () => {
  const sensitive = [
    "Set-Cookie",
    "cookie",
    "Authorization",
    "PROXY-AUTHORIZATION",
    "WWW-Authenticate",
    "Proxy-Authenticate",
  ]

  function entryWith(headers: HttpHeader[]): HarEntry {
    return only(
      buildLog(
        recording({
          hops: [
            hop({
              url: "https://example.com/?token=abc",
              requestHeaders: [...headers, { name: "Cookie", value: "sid=1; theme=dark" }],
              responseHeaders: [...headers, { name: "Set-Cookie", value: "sid=2; Path=/" }],
              postData: { mimeType: "text/plain", text: "password=hunter2" },
              body: { chunks: [u8("Authorization: secret")], complete: true },
            }),
          ],
        }),
      ),
    )
  }

  test("the six sensitive headers become [redacted], every duplicate, name kept", () => {
    const headers = sensitive.flatMap((name) => [
      { name, value: "one" },
      { name, value: "two" },
    ])
    const entry = redactEntry(entryWith([...headers, { name: "Accept", value: "x" }]))
    for (const list of [entry.request.headers, entry.response.headers]) {
      for (const header of list) {
        if (header.name === "Accept") {
          expect(header.value).toBe("x")
        } else {
          expect(header.value).toBe("[redacted]")
        }
      }
      expect(list.map((h) => h.name)).toContain("PROXY-AUTHORIZATION")
    }
  })

  test("a header carried as binaryValue does not leak", () => {
    const entry = redactEntry(
      entryWith([{ name: "Authorization", binaryValue: [0x73, 0x65, 0x63] }]),
    )
    expect(JSON.stringify(entry)).not.toContain('sec"')
    const auth = entry.request.headers.find((h) => h.name === "Authorization")
    expect(auth?.value).toBe("[redacted]")
  })

  test("every cookie value becomes [redacted]", () => {
    const entry = redactEntry(entryWith([]))
    expect(entry.request.cookies).toEqual([
      { name: "sid", value: "[redacted]" },
      { name: "theme", value: "[redacted]" },
    ])
    expect(entry.response.cookies).toEqual([{ name: "sid", value: "[redacted]", path: "/" }])
  })

  test("url, queryString, postData and content are untouched", () => {
    const raw = entryWith([])
    const entry = redactEntry(raw)
    expect(entry.request.url).toBe("https://example.com/?token=abc")
    expect(entry.request.queryString).toEqual([{ name: "token", value: "abc" }])
    expect(entry.request.postData).toEqual(raw.request.postData)
    expect(entry.response.content).toEqual(raw.response.content)
  })

  test("the input entry is not changed", () => {
    const raw = entryWith([{ name: "Authorization", value: "Bearer x" }])
    const before = JSON.stringify(raw)
    redactEntry(raw)
    expect(JSON.stringify(raw)).toBe(before)
  })
})

describe("buildLog", () => {
  test("HAR 1.2 shape with creator, pages and _recording", () => {
    const har = buildLog(recording({ hops: [hop()] }))
    expect(har.log.version).toBe("1.2")
    expect(har.log.creator).toEqual({ name: "firefox-ctl", version: "1.2.3" })
    expect(har.log.pages).toEqual([
      {
        id: "page_1",
        startedDateTime: "2026-10-02T12:00:00.000Z",
        title: "https://example.com/",
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ])
    expect(har.log._recording).toEqual({
      tabId: 7,
      startedDateTime: "2026-10-02T12:00:00.000Z",
      maxBodySize: 10485760,
      truncatedBodies: 0,
      droppedBodies: 0,
      pendingEntries: 0,
      tabClosed: false,
    })
    expect("browser" in har.log).toBe(false)
  })

  test("page timings are relative to the page start", () => {
    const pages = [
      { id: "page_1", start: T0, title: "t", domContentLoaded: T0 + 120, load: T0 + 450 },
    ]
    expect(buildLog(recording({ pages })).log.pages[0]?.pageTimings).toEqual({
      onContentLoad: 120,
      onLoad: 450,
    })
  })

  test("entries are sorted by startedDateTime, with ISO dates", () => {
    const har = buildLog(
      recording({
        hops: [
          hop({ requestId: "b", start: T0 + 50, url: "https://e.com/b" }),
          hop({ requestId: "a", start: T0 + 10, url: "https://e.com/a" }),
          hop({ requestId: "c", start: T0 + 50, url: "https://e.com/c" }),
        ],
      }),
    )
    expect(har.log.entries.map((e) => e.request.url)).toEqual([
      "https://e.com/a",
      "https://e.com/b",
      "https://e.com/c",
    ])
    expect(har.log.entries[0]?.startedDateTime).toBe("2026-10-02T12:00:00.010Z")
  })

  test("every pageref names an existing page", () => {
    const har = buildLog(
      recording({
        hops: [
          hop({ pageref: "page_1" }),
          hop({ requestId: "2", pageref: "page_9" }),
          hop({ requestId: "3" }),
        ],
      }),
    )
    const ids = new Set(har.log.pages.map((p) => p.id))
    expect(har.log.entries[0]?.pageref).toBe("page_1")
    for (const entry of har.log.entries) {
      if (entry.pageref !== undefined) {
        expect(ids.has(entry.pageref)).toBe(true)
      }
    }
    expect(har.log.entries[1]?.pageref).toBeUndefined()
  })

  test("a GET entry carries what the hop recorded", () => {
    const entry = only(
      buildLog(
        recording({
          hops: [
            hop({
              url: "https://example.com/p?q=1",
              requestHeaders: [{ name: "Cookie", value: "a=1" }],
              responseHeaders: [
                { name: "Content-Type", value: "text/html; charset=utf-8" },
                { name: "Content-Length", value: "5" },
                { name: "Set-Cookie", value: "b=2" },
              ],
              body: { chunks: [u8("he"), u8("llo")], complete: true },
              frameId: 3,
              type: "sub_frame",
            }),
          ],
        }),
      ),
    )
    expect(entry.request).toEqual({
      method: "GET",
      url: "https://example.com/p?q=1",
      httpVersion: "HTTP/1.1",
      cookies: [{ name: "a", value: "1" }],
      headers: [{ name: "Cookie", value: "a=1" }],
      queryString: [{ name: "q", value: "1" }],
      headersSize: -1,
      bodySize: 0,
    })
    expect(entry.response).toEqual({
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [{ name: "b", value: "2" }],
      headers: [
        { name: "Content-Type", value: "text/html; charset=utf-8" },
        { name: "Content-Length", value: "5" },
        { name: "Set-Cookie", value: "b=2" },
      ],
      content: { size: 5, mimeType: "text/html; charset=utf-8", text: "hello" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 5,
    })
    expect(entry.time).toBe(30)
    expect(entry.cache).toEqual({})
    expect(entry.serverIPAddress).toBe("93.184.216.34")
    expect(entry._resourceType).toBe("sub_frame")
    expect(entry._frameId).toBe(3)
    expect(entry._fromCache).toBe(false)
    expect(entry._error).toBeUndefined()
    expect(entry._pending).toBeUndefined()
  })

  test("the body chunks are released once converted", () => {
    const record = hop({ body: { chunks: [u8("x")], complete: true } })
    buildLog(recording({ hops: [record] }))
    expect(record.body?.chunks).toEqual([])
  })

  test("a redirect hop names its target", () => {
    const entry = only(
      buildLog(
        recording({
          hops: [
            hop({
              statusCode: 301,
              statusLine: "HTTP/1.1 301 Moved Permanently",
              redirectUrl: "https://example.com/new",
            }),
          ],
        }),
      ),
    )
    expect(entry.response.status).toBe(301)
    expect(entry.response.redirectURL).toBe("https://example.com/new")
  })

  test("an error before headers gives status 0", () => {
    const entry = only(
      buildLog(
        recording({
          hops: [
            hop({
              statusCode: undefined,
              statusLine: undefined,
              responseHeaders: undefined,
              headersReceived: undefined,
              error: "NS_ERROR_UNKNOWN_HOST",
            }),
          ],
        }),
      ),
    )
    expect(entry.response.status).toBe(0)
    expect(entry.response.statusText).toBe("")
    expect(entry.response.httpVersion).toBe("")
    expect(entry.response.headers).toEqual([])
    expect(entry._error).toBe("NS_ERROR_UNKNOWN_HOST")
  })

  test("the counters summarise the entries", () => {
    const har = buildLog(
      recording({
        tabClosed: true,
        hops: [
          hop({ requestId: "1", body: { chunks: [u8("x")], complete: false, truncated: true } }),
          hop({ requestId: "2", bodyDropped: true }),
          hop({ requestId: "3", pending: true, end: undefined }),
          hop({ requestId: "4", postData: { mimeType: "", text: "a", _truncated: true } }),
          hop({ requestId: "5", postData: { mimeType: "", _bodyDropped: true } }),
        ],
      }),
    )
    expect(har.log._recording).toMatchObject({
      truncatedBodies: 2,
      droppedBodies: 2,
      pendingEntries: 1,
      tabClosed: true,
    })
    expect(har.log.entries[2]?._pending).toBe(true)
  })

  test("response bodySize keeps Content-Length when the budget dropped the body", () => {
    const headers = [{ name: "Content-Length", value: "9" }]
    const dropped = only(
      buildLog(recording({ hops: [hop({ responseHeaders: headers, bodyDropped: true })] })),
    )
    expect(dropped.response.bodySize).toBe(9)
    const cut = only(
      buildLog(
        recording({
          hops: [
            hop({
              responseHeaders: headers,
              body: { chunks: [u8("ab")], complete: false, truncated: true },
            }),
          ],
        }),
      ),
    )
    expect(cut.response.bodySize).toBe(-1)
  })

  test("_securityInfo is passed through", () => {
    const securityInfo = {
      state: "secure",
      protocolVersion: "TLSv1.3",
      cipherSuite: "TLS_AES_128_GCM_SHA256",
      isExtendedValidation: false,
      hsts: true,
      hpkp: false,
    }
    expect(only(buildLog(recording({ hops: [hop({ securityInfo })] })))._securityInfo).toEqual(
      securityInfo,
    )
  })

  test("the request bodySize follows requestBodySize", () => {
    const entry = only(
      buildLog(
        recording({
          hops: [
            hop({
              method: "POST",
              requestBody: { raw: [{ bytes: { byteLength: 7 } }] },
              postData: { mimeType: "text/plain", text: "abcdefg" },
            }),
          ],
        }),
      ),
    )
    expect(entry.request.bodySize).toBe(7)
    expect(entry.request.postData).toEqual({ mimeType: "text/plain", text: "abcdefg" })
  })
})

describe("HAR 1.2 contract", () => {
  type Kind = "string" | "number" | "boolean" | "array" | "object"

  function kind(value: unknown): string {
    if (Array.isArray(value)) {
      return "array"
    }
    return value === null ? "null" : typeof value
  }

  function requireFields(value: unknown, fields: Record<string, Kind>, path: string): void {
    expect(kind(value)).toBe("object")
    const object = value as Record<string, unknown>
    for (const [name, want] of Object.entries(fields)) {
      if (kind(object[name]) !== want) {
        throw new Error(`${path}.${name} is ${kind(object[name])}, want ${want}`)
      }
    }
  }

  function requireNameValues(list: unknown, path: string): void {
    for (const [i, item] of (list as unknown[]).entries()) {
      requireFields(item, { name: "string", value: "string" }, `${path}[${i}]`)
    }
  }

  function checkEntry(entry: HarEntry): void {
    requireFields(
      entry,
      {
        startedDateTime: "string",
        time: "number",
        request: "object",
        response: "object",
        cache: "object",
        timings: "object",
      },
      "entry",
    )
    expect(new Date(entry.startedDateTime).toISOString()).toBe(entry.startedDateTime)
    requireFields(
      entry.request,
      {
        method: "string",
        url: "string",
        httpVersion: "string",
        cookies: "array",
        headers: "array",
        queryString: "array",
        headersSize: "number",
        bodySize: "number",
      },
      "request",
    )
    requireFields(
      entry.response,
      {
        status: "number",
        statusText: "string",
        httpVersion: "string",
        cookies: "array",
        headers: "array",
        content: "object",
        redirectURL: "string",
        headersSize: "number",
        bodySize: "number",
      },
      "response",
    )
    requireFields(entry.response.content, { size: "number", mimeType: "string" }, "content")
    for (const list of ["cookies", "headers", "queryString"] as const) {
      requireNameValues(entry.request[list], `request.${list}`)
    }
    requireNameValues(entry.response.cookies, "response.cookies")
    requireNameValues(entry.response.headers, "response.headers")
    requireFields(entry.timings, { send: "number", wait: "number", receive: "number" }, "timings")
    const postData = entry.request.postData
    if (postData !== undefined) {
      requireFields(postData, { mimeType: "string" }, "postData")
      expect(postData.text !== undefined && postData.params !== undefined).toBe(false)
      expect(postData.text !== undefined || postData.params !== undefined).toBe(true)
    }
  }

  test.each<[string, HopRecord]>([
    ["GET", hop({ body: { chunks: [u8("<p>")], complete: true } })],
    [
      "POST",
      hop({
        method: "POST",
        type: "xmlhttprequest",
        requestHeaders: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
        requestBody: { formData: { a: ["1"] } },
        postData: postData({ formData: { a: ["1"] } }, "application/x-www-form-urlencoded", 100),
      }),
    ],
    [
      "redirect hop",
      hop({ statusCode: 302, statusLine: "HTTP/2 302", redirectUrl: "https://example.com/next" }),
    ],
    [
      "error",
      hop({
        statusCode: undefined,
        statusLine: undefined,
        responseHeaders: undefined,
        headersReceived: undefined,
        end: T0 + 9,
        error: "NS_ERROR_CONNECTION_REFUSED",
      }),
    ],
  ])("%s entry has every required field", (_name, record) => {
    checkEntry(only(buildLog(recording({ hops: [record] }))))
  })
})

describe("fitLog", () => {
  function bodyHop(id: string, size: number, start = T0): HopRecord {
    return hop({
      requestId: id,
      url: `https://example.com/${id}`,
      start,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      body: { chunks: [u8("x".repeat(size))], complete: true },
    })
  }

  function sample(): Har {
    return buildLog(
      recording({
        hops: [
          bodyHop("small", 100, T0),
          bodyHop("large", 5000, T0 + 1),
          bodyHop("medium", 1000, T0 + 2),
          hop({ requestId: "none", start: T0 + 3, url: "https://example.com/none" }),
        ],
      }),
    )
  }

  function textOf(har: Har, id: string): string | undefined {
    return har.log.entries.find((e) => e.request.url.endsWith(`/${id}`))?.response.content.text
  }

  test("a log under the limit is returned unchanged", () => {
    const har = sample()
    const size = replyBytes(har)
    expect(fitLog(har, size)).toBe(har)
    expect(fitLog(har, size + 1)).toBe(har)
  })

  test("one byte over drops the largest body and keeps mimeType and size", () => {
    const har = sample()
    const before = JSON.stringify(har)
    const fitted = fitLog(har, replyBytes(har) - 1)
    expect(replyBytes(fitted)).toBeLessThanOrEqual(replyBytes(har) - 1)
    expect(textOf(fitted, "large")).toBeUndefined()
    expect(textOf(fitted, "medium")).toBeDefined()
    expect(textOf(fitted, "small")).toBeDefined()
    const content = fitted.log.entries.find((e) => e.request.url.endsWith("/large"))?.response
      .content
    expect(content).toEqual({ size: 5000, mimeType: "text/plain", _bodyDropped: true })
    expect(fitted.log._recording.droppedBodies).toBe(1)
    expect(JSON.stringify(har)).toBe(before)
  })

  test("drops bodies largest first until the log fits", () => {
    const har = sample()
    const fitted = fitLog(har, replyBytes(har) - 5500)
    expect(textOf(fitted, "large")).toBeUndefined()
    expect(textOf(fitted, "medium")).toBeUndefined()
    expect(textOf(fitted, "small")).toBeDefined()
    expect(fitted.log._recording.droppedBodies).toBe(2)
  })

  test("a drop removes request payloads too", () => {
    const har = buildLog(
      recording({
        hops: [
          hop({ postData: { mimeType: "text/plain", text: "y".repeat(3000) } }),
          hop({
            requestId: "2",
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              params: [{ name: "a", value: "z".repeat(2000) }],
              _formData: true,
            },
          }),
        ],
      }),
    )
    const fitted = fitLog(har, replyBytes(har) - 3500)
    expect(fitted.log.entries.map((e) => e.request.postData)).toEqual([
      { mimeType: "text/plain", _bodyDropped: true },
      { mimeType: "application/x-www-form-urlencoded", _formData: true, _bodyDropped: true },
    ])
    expect(fitted.log._recording.droppedBodies).toBe(2)
  })

  test.each<[string, HarPostData]>([
    ["empty text", { mimeType: "text/plain", text: "" }],
    [
      "empty params",
      { mimeType: "application/x-www-form-urlencoded", params: [], _formData: true },
    ],
  ])("a drop leaves an empty request body (%s) unmarked", (_name, post) => {
    const har = buildLog(
      recording({ hops: [{ ...bodyHop("large", 5000), method: "POST", postData: post }] }),
    )
    const fitted = fitLog(har, replyBytes(har) - 1)
    expect(textOf(fitted, "large")).toBeUndefined()
    expect(only(fitted).request.postData).toEqual(post)
    expect(fitted.log._recording.droppedBodies).toBe(1)
  })

  test("a drop leaves an empty response body unmarked", () => {
    const har = buildLog(
      recording({
        hops: [
          hop({
            body: { chunks: [], complete: true },
            postData: { mimeType: "text/plain", text: "y".repeat(3000) },
          }),
        ],
      }),
    )
    const fitted = fitLog(har, replyBytes(har) - 1)
    expect(only(fitted).request.postData).toEqual({ mimeType: "text/plain", _bodyDropped: true })
    expect(only(fitted).response.content._bodyDropped).toBeUndefined()
    expect(fitted.log._recording.droppedBodies).toBe(1)
  })

  test("a counter growing a digit forces one more drop", () => {
    const dropped = Array.from({ length: 9 }, (_, i) =>
      hop({ requestId: `d${i}`, bodyDropped: true }),
    )
    const har = buildLog(
      recording({
        hops: [...dropped, bodyHop("large", 5000, T0 + 1), bodyHop("small", 100, T0 + 2)],
      }),
    )
    expect(har.log._recording.droppedBodies).toBe(9)
    const once = fitLog(har, replyBytes(har) - 1)
    expect(once.log._recording.droppedBodies).toBe(10)
    expect(textOf(once, "small")).toBeDefined()
    const atLimit = fitLog(har, replyBytes(once))
    expect(textOf(atLimit, "small")).toBeDefined()
    const tight = fitLog(har, replyBytes(once) - 1)
    expect(textOf(tight, "large")).toBeUndefined()
    expect(textOf(tight, "small")).toBeUndefined()
    expect(tight.log._recording.droppedBodies).toBe(11)
  })

  test("a log too large without bodies throws HAR_TOO_LARGE", () => {
    const har = buildLog(
      recording({
        hops: [hop({ url: `https://example.com/${"p".repeat(4000)}` }), bodyHop("b", 500)],
      }),
    )
    let message = ""
    try {
      fitLog(har, 1000)
    } catch (err) {
      message = (err as Error).message
    }
    const match = /^HAR_TOO_LARGE: HAR is (\d+) bytes without bodies, the limit is 1000$/.exec(
      message,
    )
    expect(match).not.toBeNull()
    const bare = Number(match?.[1])
    expect(replyBytes(fitLog(har, bare))).toBe(bare)
  })

  test("each entry and the envelope are serialised a bounded number of times", () => {
    const har = sample()
    const limit = replyBytes(har) - 1
    const spy = spyOn(JSON, "stringify")
    try {
      fitLog(har, limit)
      // one envelope, an entry and its shell per body, one confirmation
      expect(spy).toHaveBeenCalledTimes(1 + 3 * 2 + 1)
    } finally {
      spy.mockRestore()
    }
  })
})
