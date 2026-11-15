import { createHandlers } from "@belltower/adapter-aws"
import config from "./belltower.config.json" with { type: "json" }

/*
 * The Lambda entry points. The config is bundled into the function, and is
 * checked once per cold start against the regions in BELLTOWER_REGIONS.
 */

const handlers = createHandlers(config)

export const checks = handlers.checks
export const decide = handlers.decide
export const http = handlers.http
