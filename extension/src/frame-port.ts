// The contract of the port a watched child frame opens to the background page.
// Both bundles import it: the registry admits a port by this name, the content
// script connects with it and stops answering on the one message it carries.

/** Port name the frame side of the content script connects with. */
export const FRAME_PORT_NAME = "firefox-ctl-frame"

/** Tells a frame script to stop answering; posted to every port on unwatch. */
export const DEACTIVATE_MESSAGE = { type: "deactivate" } as const

/** What a frame answers once its watch is gone, until its document unloads. */
export const FRAME_DEACTIVATED =
  "FRAME_NOT_OBSERVED: frame is deactivated; call watchFrames and reload it"

export function isDeactivateMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === DEACTIVATE_MESSAGE.type
  )
}
