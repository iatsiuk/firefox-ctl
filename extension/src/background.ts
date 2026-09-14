// Background entry point: the only place in the extension that touches globals.

import { start } from "./app"
import { realBrowser } from "./browser"
import { realEnvironment } from "./env"

start(realBrowser(), realEnvironment())
