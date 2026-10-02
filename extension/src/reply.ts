// The size a result takes on the native-messaging wire, measured before the
// reply is sent, so a large result can shrink instead of being lost.

/** Stands in for the command id, which is always a 36-character UUID. */
export const ENVELOPE_ID = "00000000-0000-0000-0000-000000000000"

/**
 * UTF-8 byte length of a string, without allocating its encoding. A lone
 * surrogate counts as the three bytes of U+FFFD, as TextEncoder writes it.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4
      i++
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/** The bytes the dispatcher would put on the wire for this result. */
export function replyBytes(result: unknown): number {
  return utf8Length(JSON.stringify({ id: ENVELOPE_ID, success: true, result }))
}
