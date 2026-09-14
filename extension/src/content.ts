// Content script entry point: the only place in the page context that binds the
// real globals into a Page.

import { realBrowser } from "./browser"
import { realPage } from "./content/page"
import { startPage } from "./page"

startPage(realBrowser(), realPage())
