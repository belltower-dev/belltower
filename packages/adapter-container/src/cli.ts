#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import {
  buildNotes,
  buildPage,
  cachedFonts,
  googleFonts,
  writePage,
  NOTES_KEY,
  decide,
  handle,
  runChecks,
  VERSION,
  type Alert,
  type DecideReport,
  type Notifier,
  type ResultsFile,
  type Store,
} from "@belltower/core"
import { nodeHttpClient } from "./node-http-client.ts"
import { everyMinute } from "./schedule.ts"
import { serveFetch } from "./server.ts"
import { CliError, containerNotifiers, envSecrets, EXIT, loadSetup, storeFromFlag, type Setup } from "./setup.ts"

/*
 * The `belltower` command for the container adapter (docs/spec.md, "The
 * command line"). Every input is a flag or an environment variable, nothing
 * prompts, --json prints a versioned shape, and exit codes are stable.
 */

export const CLI_FORMAT = "belltower.cli/1"

const HELP = `belltower ${VERSION}

Usage: belltower <command> [options]

Commands:
  validate                    Check the config against the schema and the regions
  run checks --region <name>  Run one region's checks once and write its results file
  run decide                  Judge recent results, open and resolve incidents, send alerts
  notes push [--dir <dir>]    Check the incident and maintenance notes and publish them
  page build --site-url <url> Build the static status page from the public files
  serve                       Answer heartbeat pings over HTTP
  serve --schedule            Also run every region's checks and decide each minute (one machine)

Options:
  --config <file>   Config file (.json, .js, .mjs or .ts)
                    Default: $BELLTOWER_CONFIG, or belltower.config.json
  --regions <list>  The deployment's regions, separated by commas
                    Default: $BELLTOWER_REGIONS, or "local"
  --store <where>   Where results, incidents and status are kept: a folder,
                    or s3://bucket/prefix for S3-compatible storage
                    Default: $BELLTOWER_STORE, or ./belltower-data
  --port <n>        serve: the port. Default: $PORT, or 8080
  --dir <dir>       notes push: the folder of .md notes. Default: notes
  --site-url <url>  page build: where the page is served, for feed links.
                    Default: $BELLTOWER_SITE_URL
  --out <dir>       page build: write the page to this folder instead of
                    the store's public/ folder, beside status.json
  --dry-run         run, notes push, page build: do the work, but write nothing and send no alerts
  --json            Print JSON (format ${CLI_FORMAT})
  --help            Show this help

Exit codes: 0 success, 2 usage error, 3 config invalid, 4 check failed,
5 platform error, 6 not authorized, 1 anything unexpected.
Secrets are read from environment variables named in the config. Email
notifiers also need BELLTOWER_SMTP_URL and BELLTOWER_EMAIL_FROM. An s3://
store reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
AWS_REGION, and BELLTOWER_S3_ENDPOINT for storage other than AWS. With
BELLTOWER_SITE_URL set, run decide, serve --schedule and notes push keep
the status page in the store's public/ folder current.`

export interface Io {
  out(line: string): void
  err(line: string): void
  env: NodeJS.ProcessEnv
}

const OPTIONS = {
  config: { type: "string" },
  regions: { type: "string" },
  store: { type: "string" },
  region: { type: "string" },
  port: { type: "string" },
  dir: { type: "string" },
  "site-url": { type: "string" },
  out: { type: "string" },
  schedule: { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const

/** Runs one command and returns its exit code. `serve` resolves once the server stops. */
export async function runCli(argv: readonly string[], io: Io, signal?: AbortSignal): Promise<number> {
  let json = argv.includes("--json")
  let command = ""
  try {
    let parsed
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage((error as Error).message.replace(/\. To specify.*$/s, "."), "Run belltower --help for the commands and options.")
    }
    const { values, positionals } = parsed
    json = values.json === true
    command = positionals.join(" ")
    if (values.help || command === "") {
      io.out(HELP)
      return values.help ? EXIT.ok : EXIT.usage
    }

    const configPath = values.config ?? io.env.BELLTOWER_CONFIG ?? "belltower.config.json"
    const regionsFlag = values.regions ?? io.env.BELLTOWER_REGIONS ?? "local"
    const storeDir = values.store ?? io.env.BELLTOWER_STORE ?? "belltower-data"
    const dryRun = values["dry-run"] === true
    const report = (result: unknown, human: string) => io.out(json ? JSON.stringify({ format: CLI_FORMAT, command, ok: true, result }) : human)

    switch (command) {
      case "validate": {
        const setup = await loadSetup(configPath, regionsFlag)
        report(
          { checks: setup.config.checks.length, byRegion: setup.byRegion },
          `The config is valid: ${setup.config.checks.length} checks across ${setup.regions.map((r) => r.name).join(", ")}.`,
        )
        return EXIT.ok
      }
      case "run checks": {
        if (!values.region) throw usage("run checks needs --region.", "Pass the region this run is for, such as --region us.")
        const setup = await loadSetup(configPath, regionsFlag)
        if (!setup.byRegion[values.region]) {
          throw usage(`"${values.region}" isn't one of the regions: ${Object.keys(setup.byRegion).join(", ")}.`, "Pass a region named in --regions.")
        }
        const store = withDryRun(platform(storeFromFlag(storeDir, io.env)), dryRun)
        const file = await runChecks(values.region, { ...deps(setup, store, io), http: nodeHttpClient() })
        report(file, describeResults(file, dryRun))
        return EXIT.ok
      }
      case "run decide": {
        const setup = await loadSetup(configPath, regionsFlag)
        const store = withDryRun(platform(storeFromFlag(storeDir, io.env)), dryRun)
        const would: Alert[] = []
        const notifiers = dryRun ? await recording(setup, io, would) : await containerNotifiers(setup.config, envSecrets(io.env))
        const result = await decide({ ...deps(setup, store, io), notifiers, ...(dryRun ? {} : pageDeps(io, configPath, store)) })
        report(dryRun ? { ...result, alerts: would } : result, describeDecision(result, dryRun ? would : null))
        return EXIT.ok
      }
      case "notes push": {
        const setup = await loadSetup(configPath, regionsFlag)
        const dir = values.dir ?? "notes"
        let names: string[]
        try {
          names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort()
        } catch {
          throw new CliError(EXIT.usage, [{ code: "usage", path: "--dir", message: `There's no folder at ${dir}.`, fix: "Pass the folder of notes with --dir." }])
        }
        const files = await Promise.all(names.map(async (n) => ({ file: join(dir, n), text: await readFile(join(dir, n), "utf8") })))
        const built = buildNotes(files, setup.config, new Date())
        const warnings = built.warnings.map((w) => ({ file: w.file, field: w.field, message: w.message, fix: w.fix }))
        if (!built.notes) {
          throw new CliError(
            EXIT.configInvalid,
            built.errors.map((e) => ({ code: "note-invalid", path: `${e.file}: ${e.field}`, message: e.message, ...(e.fix ? { fix: e.fix } : {}) })),
          )
        }
        let pageNote = ""
        if (!dryRun) {
          const store = platform(storeFromFlag(storeDir, io.env))
          await store.put(NOTES_KEY, JSON.stringify(built.notes), { contentType: "application/json" })
          // A new note shows on the page at once, not at the next roll-up.
          const site = pageDeps(io, configPath, store).page
          if (site && (await store.get("public/status.json")) !== null) {
            const page = await buildPage({ ...site, store, clock: { now: () => new Date() } })
            if (page.ok) await writePage(store, page.files)
            pageNote = page.ok ? "Rebuilt the status page." : `The status page wasn't rebuilt: ${page.problems.join(" ")}`
          }
        }
        const human = [
          `${dryRun ? "Would publish" : "Published"} ${built.notes.notes.length} notes to ${NOTES_KEY}.`,
          ...warnings.map((w) => `Warning: ${w.file}: ${w.message} ${w.fix ?? ""}`.trim()),
          ...(pageNote ? [pageNote] : []),
        ].join("\n")
        report({ notes: built.notes.notes.map((n) => ({ id: n.id, type: n.type, start: n.start, end: n.end ?? null })), warnings, dryRun }, human)
        return EXIT.ok
      }
      case "page build": {
        const siteUrl = values["site-url"] ?? io.env.BELLTOWER_SITE_URL
        if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw usage("page build needs --site-url.", "Pass the address the page is served from, such as --site-url https://status.example.com/.")
        const store = platform(storeFromFlag(storeDir, io.env))
        // Into the store, fonts already published are reused; into a separate folder, they're fetched.
        const loadFont = values.out ? googleFonts() : cachedFonts(store, googleFonts())
        const built = await buildPage({ store, clock: { now: () => new Date() }, siteUrl, loadTheme: themeLoader(configPath), loadFont })
        if (!built.ok) throw new CliError(EXIT.configInvalid, built.problems.map((message) => ({ code: "page-invalid", path: "page", message })))
        const paths = Object.keys(built.files).sort()
        if (!dryRun) {
          if (values.out) {
            for (const path of paths) {
              const file = join(values.out, path)
              await mkdir(dirname(file), { recursive: true })
              await writeFile(file, built.files[path] ?? "")
            }
          } else await writePage(store, built.files)
        }
        const where = values.out ?? "the store's public/ folder"
        report(
          { files: paths, out: values.out ?? "public/", dryRun, warnings: built.warnings },
          [`${dryRun ? "Would write" : "Wrote"} ${paths.length} files to ${where}.`, ...built.warnings.map((w) => `Warning: ${w}`)].join("\n"),
        )
        return EXIT.ok
      }
      case "serve": {
        const setup = await loadSetup(configPath, regionsFlag)
        const store = platform(storeFromFlag(storeDir, io.env))
        const notifiers = await containerNotifiers(setup.config, envSecrets(io.env))
        return await serve(setup, store, notifiers, Number(values.port ?? io.env.PORT ?? 8080), values.schedule === true, io, json, signal, configPath)
      }
      default:
        throw usage(`"${command}" isn't a command.`, "Run belltower --help for the commands.")
    }
  } catch (error) {
    const known = error instanceof CliError
    const exitCode = known ? error.exitCode : EXIT.unexpected
    const issues = known ? error.issues : [{ code: "unexpected", path: "", message: error instanceof Error ? error.message : String(error) }]
    if (json) io.out(JSON.stringify({ format: CLI_FORMAT, command, ok: false, exitCode, errors: issues }))
    else for (const i of issues) io.err(`${i.path ? `${i.path}: ` : ""}${i.message}${i.fix ? ` ${i.fix}` : ""}`)
    return exitCode
  }
}

function usage(message: string, fix: string): CliError {
  return new CliError(EXIT.usage, [{ code: "usage", path: "", message, fix }])
}

function deps(setup: Setup, store: Store, io: Io) {
  return { config: setup.config, byRegion: setup.byRegion, store, secrets: envSecrets(io.env), clock: { now: () => new Date() } }
}

/** With BELLTOWER_SITE_URL set, decide() keeps the status page beside status.json current. */
function pageDeps(io: Io, configPath: string, store: Store) {
  const siteUrl = io.env.BELLTOWER_SITE_URL
  if (!siteUrl) return {}
  return { page: { siteUrl, loadTheme: themeLoader(configPath), loadFont: cachedFonts(store, googleFonts()) } }
}

/** A theme given as a path is read relative to the config file. */
function themeLoader(configPath: string) {
  return async (ref: string) => JSON.parse(await readFile(isAbsolute(ref) ? ref : resolve(dirname(configPath), ref), "utf8")) as unknown
}

/** Store failures are platform errors (exit 5), not bugs. */
function platform(store: Store): Store {
  const wrap =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await f(...a)
      } catch (error) {
        throw new CliError(EXIT.platformError, [
          { code: "store-error", path: "", message: `The store failed: ${(error as Error).message}`, fix: "Check that the --store folder or bucket exists and can be written, and that its credentials are current." },
        ])
      }
    }
  return { get: wrap(store.get.bind(store)), put: wrap(store.put.bind(store)), list: wrap(store.list.bind(store)) }
}

/** Reads from the real store; keeps writes in memory, so a dry run changes nothing. */
function withDryRun(store: Store, dryRun: boolean): Store {
  if (!dryRun) return store
  const written = new Map<string, string>()
  return {
    get: async (key) => written.get(key) ?? store.get(key),
    put: async (key, body) => void written.set(key, typeof body === "string" ? body : new TextDecoder().decode(body)),
    list: async (prefix) => [...new Set([...(await store.list(prefix)), ...[...written.keys()].filter((k) => k.startsWith(prefix))])].sort(),
  }
}

async function recording(setup: Setup, io: Io, into: Alert[]): Promise<Notifier[]> {
  // One recorder per configured notifier, so the dry run shows each alert once per notifier that would send it.
  return (await containerNotifiers(setup.config, envSecrets(io.env))).map((n) => ({ upTo: n.upTo, send: async (alert: Alert) => void into.push(alert) }))
}

async function serve(setup: Setup, store: Store, notifiers: Notifier[], port: number, schedule: boolean, io: Io, json: boolean, signal: AbortSignal | undefined, configPath: string): Promise<number> {
  const log = (event: string, detail: Record<string, unknown>, human: string) =>
    io.out(json ? JSON.stringify({ format: CLI_FORMAT, command: "serve", event, at: new Date().toISOString(), ...detail }) : human)
  const secrets = envSecrets(io.env)
  const server = serveFetch(
    (request) => handle(request, { config: setup.config, store, secrets, clock: { now: () => new Date() } }),
    (error) => log("error", { message: String(error) }, `Error answering a request: ${String(error)}`),
  )
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new CliError(EXIT.platformError, [{ code: "listen-failed", path: "--port", message: `Couldn't listen on port ${port}: ${error.message}`, fix: "Pick a free port with --port." }])))
    server.listen(port, resolve)
  })
  log("listening", { port, schedule }, `Listening on port ${port}${schedule ? ", running checks and decide every minute" : ""}.`)

  const timer = schedule
    ? everyMinute(
        async (at) => {
          const http = nodeHttpClient()
          try {
            const files = await Promise.all(setup.regions.map((r) => runChecks(r.name, { ...deps(setup, store, io), http })))
            for (const file of files) log("checks", { region: file.region, results: file.results }, describeResults(file, false))
            const result = await decide({ ...deps(setup, store, io), notifiers, ...pageDeps(io, configPath, store) })
            log("decide", { ...result }, describeDecision(result, null))
          } catch (error) {
            log("error", { message: (error as Error).message }, `The ${at.toISOString().slice(11, 16)} run failed: ${(error as Error).message}`)
          }
        },
        (at) => log("skipped", { minute: at.toISOString() }, `Skipped ${at.toISOString().slice(11, 16)}: the previous minute's run is still going.`),
      )
    : null

  await new Promise<void>((resolve) => {
    const stop = () => {
      timer?.stop()
      server.close(() => resolve())
    }
    if (signal?.aborted) stop()
    signal?.addEventListener("abort", stop, { once: true })
  })
  return EXIT.ok
}

function describeResults(file: ResultsFile, dryRun: boolean): string {
  const failed = file.results.filter((r) => !r.ok)
  const lines = [`${file.region}: ${file.results.length} checks, ${file.results.length - failed.length} passed, ${failed.length} failed${dryRun ? " (dry run, nothing written)" : ""}.`]
  for (const r of failed) lines.push(`  ${r.id}: ${r.message ?? r.failure}`)
  return lines.join("\n")
}

function describeDecision(report: DecideReport, wouldSend: Alert[] | null): string {
  const lines = [Object.entries(report.states).map(([id, s]) => `${id} ${s}`).join(", ") || "No checks to judge."]
  for (const i of report.opened) lines.push(`Opened ${i.id} (${i.priority}): ${Object.values(i.checks).map((c) => c.summary.split("\n")[0]).join(" ")}`)
  for (const i of report.resolved) lines.push(`Resolved ${i.id}.`)
  if (wouldSend) for (const a of wouldSend) lines.push(`Would send: ${a.title}`)
  for (const p of report.problems) lines.push(`Problem: ${p}`)
  return lines.join("\n")
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const controller = new AbortController()
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => controller.abort())
  const code = await runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }, controller.signal)
  process.exitCode = code
}
