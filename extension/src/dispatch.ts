// Turns host command frames into extension responses: a handler table keyed on
// the command name.

import { AttachedTabs } from "./attached"
import type { Browser } from "./browser"
import { CaptureLocks } from "./capture-locks"
import type { Environment } from "./env"
import { attachTab, detachTab, listAllTabs } from "./handlers/attached"
import { getNetworkRequests } from "./handlers/devtools"
import { PAGE_COMMANDS, pageHandlers } from "./handlers/dom"
import { screenshot } from "./handlers/screenshot"
import { closeTab, closeWindow, getActiveTab, getTabs, navigate } from "./handlers/tabs"
import {
  canNavigate,
  createWindow,
  getWindowMode,
  getWindows,
  resizeWindow,
  setViewport,
} from "./handlers/window"
import { StateLock } from "./lock"
import { RestoreMemo } from "./memo"
import { NetworkTracker } from "./network"
import type {
  CommandContext,
  CommandName,
  ExtensionResponse,
  HostCommand,
  JsonObject,
  JsonValue,
} from "./protocol"
import { commandContext, ExtensionError, isCommandName, withoutRequestTimeout } from "./protocol"
import type { ReadinessCheck } from "./readiness"
import { waitForPageReady } from "./readiness"
import { Session } from "./session"
import { errorText } from "./tab-errors"

export { describeTabError } from "./tab-errors"

/** Everything a dispatcher owns for the whole background lifetime. */
export interface Services {
  readonly browser: Browser
  readonly env: Environment
  readonly session: Session
  readonly attached: AttachedTabs
  readonly network: NetworkTracker
  /** One capture lock per live tab, shared by every screenshot of that tab. */
  readonly captureLocks: CaptureLocks
  /** Injected so a capture can be tested without driving the whole pipeline. */
  readonly readiness: ReadinessCheck
}

/** The services plus the deadline of the command being served. */
export interface HandlerDeps extends Services {
  readonly ctx: CommandContext
}

export type Handler = (params: JsonObject, deps: HandlerDeps) => JsonValue | Promise<JsonValue>

/**
 * Liveness probes. They read no session state, so they skip the preamble and
 * the lock: ping must answer while a restore or another command hangs.
 */
export const PROBE_COMMANDS: readonly CommandName[] = ["ping", "version"]

const probes: ReadonlySet<string> = new Set<string>(PROBE_COMMANDS)

/** True for the commands that answer without touching the session. */
export function isProbeCommand(name: string): boolean {
  return probes.has(name)
}

/**
 * Commands that mutate `Session` or `AttachedTabs` across await points. They
 * take the state lock; everything else - reads, navigation, geometry and the
 * page commands - runs concurrently once the preamble is done.
 */
const STATE_COMMANDS: readonly CommandName[] = [
  "createWindow",
  "closeTab",
  "closeWindow",
  "attachTab",
  "detachTab",
]

const stateCommands: ReadonlySet<string> = new Set<string>(STATE_COMMANDS)

/** True for the commands that serialise behind the state lock. */
function isStateCommand(name: string): boolean {
  return stateCommands.has(name)
}

/**
 * One command in flight: whether its deadline has already answered for it, and
 * the preamble attempt it is waiting on, so the deadline can abandon that one
 * too.
 */
interface CommandRun {
  expired: boolean
  preamble?: Promise<void>
}

/** The restores of one preamble attempt while they are still pending. */
interface Restores {
  session?: Promise<void>
  attached?: Promise<void>
}

export class Dispatcher {
  readonly deps: Services

  private readonly handlers = new Map<CommandName, Handler>()

  // the host may have several commands in flight at once (up to 10 concurrent
  // CLI connections, docs/architecture.md); only the commands that mutate
  // session state serialise, so a hung page command never holds the rest up
  private readonly lock = new StateLock()

  // one shared preamble: concurrent commands read storage once and never
  // interleave the pool drop
  private readonly preamble = new RestoreMemo()

  private restores: Restores = {}

  constructor(deps: Services) {
    this.deps = deps
  }

  register(name: CommandName, handler: Handler): void {
    this.handlers.set(name, handler)
  }

  has(name: string): boolean {
    return isCommandName(name) && this.handlers.has(name)
  }

  /**
   * Answers one command frame within the budget its `_timeout` allows. The
   * deadline starts here, so it covers the lock wait, the preamble, the
   * handler and the persist alike; a command that outlives it is answered, not
   * cancelled, and whatever it produces later is dropped.
   */
  async handle(command: HostCommand): Promise<ExtensionResponse> {
    const ctx = commandContext(command.params, this.deps.env)
    const scoped: HostCommand = { ...command, params: withoutRequestTimeout(command.params) }
    const handler = isCommandName(command.command) ? this.handlers.get(command.command) : undefined
    if (!handler) {
      return {
        id: command.id,
        success: false,
        error: new ExtensionError("UNKNOWN_COMMAND", command.command).message,
      }
    }
    const active: CommandRun = { expired: false }
    if (isProbeCommand(command.command)) {
      return this.awaitWithin(command, ctx, this.invoke(scoped, handler, ctx), active)
    }
    return this.awaitWithin(command, ctx, this.run(scoped, handler, ctx, active), active)
  }

  /**
   * Races the command against its deadline. The timed-out reply is sent at
   * once; the command itself keeps running, and its late result is logged and
   * dropped instead of reaching the host.
   */
  private async awaitWithin(
    command: HostCommand,
    ctx: CommandContext,
    work: Promise<ExtensionResponse>,
    active: CommandRun,
  ): Promise<ExtensionResponse> {
    const { env } = this.deps
    const answered = work.catch((error: unknown) => this.failed(command, error))
    let timerId = 0
    const deadline = new Promise<ExtensionResponse>((resolve) => {
      timerId = env.setTimeout(
        () => {
          active.expired = true
          resolve(timedOut(command, ctx))
        },
        Math.max(0, ctx.deadlineAt - env.now()),
      )
    })
    const response = await Promise.race([answered, deadline])
    if (!active.expired) {
      env.clearTimeout(timerId)
      return response
    }
    this.abandonPreamble(active)
    void answered.then((late) => {
      console.warn(`[firefox-ctl] ${command.command} finished after its deadline, dropping:`, late)
    })
    return response
  }

  /**
   * A preamble nobody waits for any more is dropped, so the next command
   * retries it; the epoch fence makes the abandoned attempt discard whatever it
   * produces when it finally settles.
   */
  private abandonPreamble(active: CommandRun): void {
    if (!active.preamble || !this.preamble.abandon(active.preamble)) {
      return
    }
    const { session, attached } = this.restores
    if (session) {
      this.deps.session.abandonRestore(session)
    }
    if (attached) {
      this.deps.attached.abandonRestore(attached)
    }
  }

  private async run(
    command: HostCommand,
    handler: Handler,
    ctx: CommandContext,
    active: CommandRun,
  ): Promise<ExtensionResponse> {
    // a failed preamble leaves storage alone: the stored session must survive a
    // transient storage error instead of being overwritten with an empty state
    const failure = await this.prepare(active).then(
      () => null,
      (error: unknown) => error ?? new Error("preamble failed"),
    )
    if (failure) {
      return this.failed(command, failure)
    }
    if (active.expired) {
      return timedOut(command, ctx)
    }
    if (!isStateCommand(command.command)) {
      return this.execute(command, handler, ctx)
    }
    // the lock passes on only when this command really settles, never because
    // its deadline already answered: a late tab or storage write of the old
    // holder must not interleave with the next owner's
    const release = await this.lock.acquire()
    try {
      // a command whose deadline fired while it waited never enters: answering
      // it twice is pointless and its side effects are no longer wanted
      return active.expired ? timedOut(command, ctx) : await this.execute(command, handler, ctx)
    } finally {
      release()
    }
  }

  private async execute(
    command: HostCommand,
    handler: Handler,
    ctx: CommandContext,
  ): Promise<ExtensionResponse> {
    try {
      return await this.invoke(command, handler, ctx)
    } finally {
      // a handler that threw halfway may still have moved a tab, so the stored
      // state follows memory either way
      await this.deps.session.persist().catch((error: unknown) => {
        console.warn("[firefox-ctl] session persist failed:", error)
      })
    }
  }

  private async invoke(
    command: HostCommand,
    handler: Handler,
    ctx: CommandContext,
  ): Promise<ExtensionResponse> {
    try {
      const result = await handler(command.params, { ...this.deps, ctx })
      return { id: command.id, success: true, result }
    } catch (error) {
      return this.failed(command, error)
    }
  }

  /**
   * One shared attempt for all commands in flight, so storage is read once and
   * the pool drop never interleaves. The tracker holds it only while this
   * command waits, so a deadline drops the attempt it is really stuck on.
   */
  private async prepare(active: CommandRun): Promise<void> {
    const attempt = this.preamble.run((epoch) => this.prepareOnce(epoch))
    active.preamble = attempt
    try {
      await attempt
    } finally {
      active.preamble = undefined
    }
  }

  /** The tracker holds whichever restore is still in flight, for the deadline. */
  private async prepareOnce(epoch: number): Promise<void> {
    const { session, attached } = this.deps
    const restores: Restores = {}
    this.restores = restores
    restores.session = session.restore()
    await restores.session
    restores.session = undefined
    if (!this.preamble.isCurrent(epoch)) {
      return
    }
    restores.attached = attached.restore()
    await restores.attached
    restores.attached = undefined
    if (!this.preamble.isCurrent(epoch)) {
      return
    }
    await attached.dropPoolTabs(session, () => this.preamble.isCurrent(epoch))
  }

  private failed(command: HostCommand, error: unknown): ExtensionResponse {
    console.error(`[firefox-ctl] ${command.command} failed:`, error)
    return { id: command.id, success: false, error: errorText(error) }
  }
}

/** The reply a command gets when its budget ran out, whatever it is doing. */
function timedOut(command: HostCommand, ctx: CommandContext): ExtensionResponse {
  return {
    id: command.id,
    success: false,
    error: new ExtensionError(
      "COMMAND_TIMEOUT",
      `${command.command} did not finish within ${ctx.budgetMs} ms.`,
    ).message,
  }
}

export const ping: Handler = (_params, { env }) => ({ pong: true, timestamp: env.now() })

// the browser user agent is deliberately absent: it is technicalAndInteraction data,
// which a manifest may only declare as optional
export const version: Handler = (_params, { browser }) => ({
  extension: browser.runtime.getManifest().version,
  // grows as later plans add capabilities
  features: ["sessions", "dom", "devtools"],
})

/** Every command of the session, window, tab and page plans, plus the two probes. */
export function createDispatcher(browser: Browser, env: Environment): Dispatcher {
  const dispatcher = new Dispatcher({
    browser,
    env,
    session: new Session(browser, env),
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    readiness: waitForPageReady,
  })
  dispatcher.register("ping", ping)
  dispatcher.register("version", version)
  dispatcher.register("createWindow", createWindow)
  dispatcher.register("navigate", navigate)
  dispatcher.register("canNavigate", canNavigate)
  dispatcher.register("getWindowMode", getWindowMode)
  dispatcher.register("getActiveTab", getActiveTab)
  dispatcher.register("getTabs", getTabs)
  dispatcher.register("listAllTabs", listAllTabs)
  dispatcher.register("attachTab", attachTab)
  dispatcher.register("detachTab", detachTab)
  dispatcher.register("closeTab", closeTab)
  dispatcher.register("closeWindow", closeWindow)
  dispatcher.register("getWindows", getWindows)
  dispatcher.register("resizeWindow", resizeWindow)
  dispatcher.register("setViewport", setViewport)
  dispatcher.register("screenshot", screenshot)
  dispatcher.register("getNetworkRequests", getNetworkRequests)
  for (const command of PAGE_COMMANDS) {
    dispatcher.register(command, pageHandlers[command])
  }
  return dispatcher
}
