import { HISTORY_FORMAT, HISTORY_KEY, type PublicHistory } from "../availability.ts"
import { PAGE_FORMAT, PAGE_KEY, STATUS_FORMAT, STATUS_KEY, type PublicPage, type PublicStatus } from "../decide.ts"
import { buildFeeds, buildSummary, pagePaths } from "../feeds.ts"
import { NOTES_FORMAT, NOTES_KEY, type PublicNotes } from "../notes.ts"
import type { Clock, Store } from "../ports.ts"
import { componentsMarkdown, groupMarkdown, incidentMarkdown, incidentsMarkdown, llmsTxt, maintenanceMarkdown, maintenanceNoteMarkdown, statusMarkdown } from "./markdown-pages.ts"
import { buildModel } from "./model.ts"
import { componentsPage, groupPage, incidentPage, incidentsPage, maintenanceNotePage, maintenancePage, statusPage } from "./pages.ts"
import { fontCssPath, firstFamily, type FontLoader } from "./fonts.ts"
import { PAGE_CSS, themeCss } from "./styles.ts"
import { checkContrast, describeProblem, NEUTRAL_THEME, readRegistryTheme, resolveTheme, type RegistryTheme } from "./theme.ts"

/*
 * buildPage() (docs/spec.md, "Status page"): reads the public files alone,
 * never the config, checks the theme's contrast, and returns every file of
 * the static page. Nothing is written when the theme fails.
 */

export interface BuildPageDeps {
  store: Store
  clock: Clock
  /** Where the page is served, such as https://status.example.com/. */
  siteUrl: string
  /** Reads a theme given as a file path. Adapters supply it; a URL is fetched without it. */
  loadTheme?: (ref: string) => Promise<unknown>
  /** Fetches the fonts the theme names, to serve from the page's own host. Without it the page lists them in its font stacks only. */
  loadFont?: FontLoader
  fetch?: typeof fetch
}

export type BuildPageResult =
  /** `warnings` are things the page does without, such as a font that couldn't be fetched. */
  | { ok: true; files: Record<string, string | Uint8Array>; warnings: string[] }
  | { ok: false; problems: string[] }

async function readPublic<T extends { format?: string }>(store: Store, key: string, format: string): Promise<T | null | string> {
  const text = await store.get(key)
  if (text === null) return null
  try {
    const value = JSON.parse(text) as T
    if (value.format !== format) return `${key} has format ${JSON.stringify(value.format)}, expected ${format}.`
    return value
  } catch {
    return `${key} isn't valid JSON.`
  }
}

async function loadTheme(ref: PublicPage["page"]["theme"], deps: BuildPageDeps): Promise<RegistryTheme | string> {
  if (ref === undefined) return NEUTRAL_THEME
  if (typeof ref !== "string") {
    const theme = readRegistryTheme(ref)
    return typeof theme === "string" ? `page.theme ${theme}` : theme
  }
  let raw: unknown
  try {
    if (/^https?:\/\//i.test(ref) && !deps.loadTheme) {
      const response = await (deps.fetch ?? fetch)(ref)
      if (!response.ok) return `page.theme: ${ref} answered ${response.status}. Check the address, or save the theme in the repository and give its path.`
      raw = await response.json()
    } else if (deps.loadTheme) raw = await deps.loadTheme(ref)
    else return `page.theme is the path ${ref}, and this build can't read files. Give the theme inline or as a URL, or build with the command line.`
  } catch (error) {
    return `page.theme: ${ref} couldn't be read (${(error as Error).message}).`
  }
  const theme = readRegistryTheme(raw)
  return typeof theme === "string" ? `page.theme (${ref}) ${theme}` : theme
}

export async function buildPage(deps: BuildPageDeps): Promise<BuildPageResult> {
  const problems: string[] = []
  const status = await readPublic<PublicStatus>(deps.store, STATUS_KEY, STATUS_FORMAT)
  const page = await readPublic<PublicPage>(deps.store, PAGE_KEY, PAGE_FORMAT)
  const history = await readPublic<PublicHistory>(deps.store, HISTORY_KEY, HISTORY_FORMAT)
  const notes = await readPublic<PublicNotes>(deps.store, NOTES_KEY, NOTES_FORMAT)
  for (const [value, key] of [[status, STATUS_KEY], [page, PAGE_KEY]] as const) {
    if (value === null) problems.push(`${key} is missing. Run decide() at least once before building the page.`)
  }
  for (const value of [status, page, history, notes]) if (typeof value === "string") problems.push(value)
  if (problems.length || !status || !page || typeof status === "string" || typeof page === "string") return { ok: false, problems }

  const theme = await loadTheme(page.page.theme, deps)
  if (typeof theme === "string") return { ok: false, problems: [theme] }
  const resolved = resolveTheme(theme, page.page.states)
  const contrast = checkContrast(resolved)
  if (contrast.length) return { ok: false, problems: contrast.map(describeProblem) }

  const now = deps.clock.now()
  const model = buildModel({ status, history: typeof history === "string" ? null : history, notes: typeof notes === "string" ? null : notes, page, now })
  const siteUrl = deps.siteUrl.endsWith("/") ? deps.siteUrl : `${deps.siteUrl}/`
  const input = { status, notes: typeof notes === "string" ? null : notes, page, siteUrl, now }
  const feeds = buildFeeds(input)

  // Fonts the theme names, served from the page's own host.
  const warnings: string[] = []
  const fontFiles: Record<string, string | Uint8Array> = {}
  const faces: string[] = []
  if (deps.loadFont) {
    for (const [role, stack] of [["font-sans", resolved.fonts.sans], ["font-mono", resolved.fonts.mono]] as const) {
      const family = firstFamily(stack)
      if (!family) continue
      try {
        const font = await deps.loadFont(family)
        if (!font) {
          warnings.push(`The theme's ${role} "${family}" isn't on Google Fonts, so the page uses it only where it's installed.`)
          continue
        }
        faces.push(font.css)
        fontFiles[fontCssPath(family)] = font.css
        Object.assign(fontFiles, font.files)
      } catch (error) {
        warnings.push(`The theme's ${role} "${family}" couldn't be fetched (${(error as Error).message}); the page uses it only where it's installed.`)
      }
    }
  }

  const files: Record<string, string | Uint8Array> = {
    ...fontFiles,
    "style.css": `${faces.length ? `${faces.join("\n")}\n` : ""}${themeCss(resolved)}\n${PAGE_CSS}`,
    "index.html": statusPage(model).html,
    "index.md": statusMarkdown(model),
    "components.html": componentsPage(model),
    "components.md": componentsMarkdown(model),
    "maintenance.html": maintenancePage(model),
    "maintenance.md": maintenanceMarkdown(model),
    "incidents.html": incidentsPage(model),
    "incidents.md": incidentsMarkdown(model),
    "summary.json": JSON.stringify(buildSummary(input), null, 2),
    "feed.atom": feeds.atom,
    "feed.rss": feeds.rss,
    "feed.json": feeds.json,
    "llms.txt": llmsTxt(model),
  }
  for (const g of model.groups) {
    files[pagePaths.group(g.slug)] = groupPage(model, g)
    files[pagePaths.group(g.slug).replace(/\.html$/, ".md")] = groupMarkdown(model, g)
  }
  for (const i of model.incidents) {
    files[pagePaths.incident(i.id)] = incidentPage(model, i)
    files[pagePaths.incident(i.id).replace(/\.html$/, ".md")] = incidentMarkdown(model, i)
  }
  for (const m of model.maintenance) {
    files[pagePaths.incident(m.note.id)] = maintenanceNotePage(model, m)
    files[pagePaths.incident(m.note.id).replace(/\.html$/, ".md")] = maintenanceNoteMarkdown(m)
  }
  return { ok: true, files, warnings }
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  atom: "application/atom+xml",
  rss: "application/rss+xml",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
}

export function contentType(path: string): string {
  return CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1)] ?? "application/octet-stream"
}

/** Writes the built page next to status.json, under public/, so one static host serves both. */
export async function writePage(store: Store, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [path, body] of Object.entries(files)) await store.put(`public/${path}`, body, { contentType: contentType(path) })
}
