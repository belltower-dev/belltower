import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { emailNotifier, smtpSettings } from "./email-notifier.ts"
import {
  buildNotifiers,
  validateConfig,
  type Capabilities,
  type Config,
  type ConfigIssue,
  type Notifier,
  type Region,
  type Secrets,
} from "@belltower/core"

/*
 * Turns flags and environment variables into what the core's entry points
 * need: the validated config, the regions, secrets and notifiers.
 */

/** What a region on the container adapter can do. */
export const CONTAINER_CAPABILITIES: Capabilities = {
  tlsInspector: false,
  inbox: false,
  sms: false,
  skipTlsVerify: true,
  timingBreakdown: true,
}

/** Raised for anything the user can fix: a bad flag, file or config. */
export class CliError extends Error {
  readonly exitCode: number
  readonly issues: ConfigIssue[] | { code: string; path: string; message: string; fix?: string }[]

  constructor(exitCode: number, issues: CliError["issues"]) {
    super(issues.map((i) => i.message).join(" "))
    this.exitCode = exitCode
    this.issues = issues
  }
}

export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  configInvalid: 3,
  checkFailed: 4,
  platformError: 5,
  notAuthorized: 6,
} as const

export function envSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return { get: async (name) => env[name] ?? null }
}

export function parseRegions(value: string): Region[] {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean)
  const bad = names.find((n) => !/^[a-z0-9][a-z0-9_-]*$/.test(n))
  if (!names.length || bad !== undefined) {
    throw new CliError(EXIT.usage, [
      {
        code: "usage",
        path: "--regions",
        message: bad === undefined ? "No regions given." : `"${bad}" isn't a valid region name.`,
        fix: 'Pass region names separated by commas, using lowercase letters, digits, "-" and "_", such as --regions us,eu.',
      },
    ])
  }
  return [...new Set(names)].map((name) => ({ name, capabilities: CONTAINER_CAPABILITIES }))
}

/** Reads a config file: JSON, or a JS or TS module whose default export is the config. */
export async function loadConfigFile(path: string): Promise<unknown> {
  const full = resolve(path)
  const ext = extname(full)
  try {
    if (ext === ".json") return JSON.parse(await readFile(full, "utf8"))
    if ([".js", ".mjs", ".ts", ".mts"].includes(ext)) return ((await import(pathToFileURL(full).href)) as { default: unknown }).default
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    throw new CliError(EXIT.configInvalid, [
      {
        code: missing ? "config-not-found" : "config-unreadable",
        path: "",
        message: missing ? `There's no config file at ${full}.` : `${full} couldn't be read: ${(error as Error).message}`,
        fix: missing ? "Pass --config <file>, or set BELLTOWER_CONFIG." : "Fix the file's syntax, then run belltower validate.",
      },
    ])
  }
  throw new CliError(EXIT.usage, [
    { code: "usage", path: "--config", message: `${full} has an extension Belltower doesn't read.`, fix: "Use a .json, .js, .mjs or .ts file." },
  ])
}

export interface Setup {
  config: Config
  byRegion: Record<string, string[]>
  regions: Region[]
}

export async function loadSetup(configPath: string, regionsFlag: string): Promise<Setup> {
  const regions = parseRegions(regionsFlag)
  const result = validateConfig(await loadConfigFile(configPath), regions)
  if (!result.ok) throw new CliError(EXIT.configInvalid, result.issues)
  return { config: result.config, byRegion: result.byRegion, regions }
}

/** Notifiers for decide(): webhooks from the core, email by SMTP. SMS isn't available on this adapter. */
export async function containerNotifiers(config: Config, secrets: Secrets): Promise<Notifier[]> {
  const emailIndex = config.notifiers.findIndex((n) => n.type === "email")
  let smtp: Awaited<ReturnType<typeof smtpSettings>> | null = null
  if (emailIndex !== -1) {
    smtp = await smtpSettings(secrets)
    if ("missing" in smtp) {
      throw new CliError(EXIT.configInvalid, [
        {
          code: "missing-secret",
          path: `/notifiers/${emailIndex}`,
          message: `Email notifiers need the secrets ${smtp.missing.join(" and ")}, which aren't set.`,
          fix: "Set BELLTOWER_SMTP_URL to your SMTP server, such as smtp://user:password@smtp.example.com:587, and BELLTOWER_EMAIL_FROM to the sender address.",
        },
      ])
    }
  }
  const settings = smtp && !("missing" in smtp) ? smtp : null
  try {
    return buildNotifiers(config.notifiers, {
      secrets,
      others: settings ? { email: (c) => emailNotifier(c as Extract<typeof c, { type: "email" }>, settings) } : {},
    })
  } catch (error) {
    const index = config.notifiers.findIndex((n) => n.type === "sms")
    throw new CliError(EXIT.configInvalid, [
      { code: "missing-capability", path: `/notifiers/${Math.max(index, 0)}/type`, message: (error as Error).message },
    ])
  }
}
