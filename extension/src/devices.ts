// Viewport presets. Pure data plus the classification
// of custom sizes, so the table needs no browser to be exercised.

import type { JsonObject } from "./protocol"

export type DeviceType = "mobile" | "tablet" | "desktop"

export interface DevicePreset {
  width: number
  height: number
  type: DeviceType
}

/** Content-area sizes, window chrome excluded. */
export const DEVICES: Record<string, DevicePreset> = {
  "iphone-se": { width: 375, height: 667, type: "mobile" },
  "iphone-14": { width: 390, height: 844, type: "mobile" },
  "iphone-14-pro-max": { width: 430, height: 932, type: "mobile" },
  "pixel-7": { width: 412, height: 915, type: "mobile" },
  "galaxy-s23": { width: 360, height: 780, type: "mobile" },
  "ipad-mini": { width: 768, height: 1024, type: "tablet" },
  "ipad-pro-11": { width: 834, height: 1194, type: "tablet" },
  "ipad-pro-12": { width: 1024, height: 1366, type: "tablet" },
  laptop: { width: 1366, height: 768, type: "desktop" },
  desktop: { width: 1920, height: 1080, type: "desktop" },
}

export const DEVICE_NAMES = Object.keys(DEVICES)

const TABLET_MIN_WIDTH = 768
const DESKTOP_MIN_WIDTH = 1024

export interface Viewport extends DevicePreset {
  /** A preset name, or `custom` for an explicit width and height. */
  device: string
}

/** The viewport a `setViewport` call asks for: a preset or a custom size. */
export function resolveViewport(params: JsonObject): Viewport {
  const device = typeof params.device === "string" ? params.device : undefined
  const preset = device === undefined ? undefined : DEVICES[device]
  if (device !== undefined && preset) {
    return { device, ...preset }
  }
  const width = sizeOf(params.width)
  const height = sizeOf(params.height)
  // an unknown preset name falls through to the size check
  if (width === undefined || height === undefined) {
    throw new Error(`Specify device preset or width/height. Available: ${DEVICE_NAMES.join(", ")}`)
  }
  return { device: "custom", width, height, type: classifyWidth(width) }
}

export function classifyWidth(width: number): DeviceType {
  if (width < TABLET_MIN_WIDTH) {
    return "mobile"
  }
  return width < DESKTOP_MIN_WIDTH ? "tablet" : "desktop"
}

function sizeOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return value
}
