import type { Config } from "./config.ts"
import { STATE_WORDS, type ComponentState } from "./states.ts"

/*
 * Incident and maintenance notes (docs/spec.md, "Incidents and alerts",
 * "Maintenance"): Markdown files in the deployment's repository, published
 * to public/notes.json. A note starts with a short header between --- lines:
 *
 *   ---
 *   type: maintenance            (or incident, or notice)
 *   title: Database upgrade
 *   components: API, Website     (or component: API)
 *   start: 2026-11-20T02:00:00Z
 *   end: 2026-11-20T03:00:00Z    (optional for an incident still open)
 *   detected: api-202611200205   (incident only: the detected incidents it explains)
 *   impact: major                (incident only: none, minor, major or critical)
 *   ---
 *   What's happening, in Markdown.
 *
 *   ## 2026-11-20 02:40 UTC Identified
 *   Components: API (Degraded performance), Website (Operational)
 *   An update. Each heading like this starts one; the stage and the
 *   Components line are optional.
 *
 * A notice is a standing message with no effect on states or alerts; its
 * components and times are optional.
 */

export const NOTES_FORMAT = "belltower.notes/1"
export const NOTES_KEY = "public/notes.json"

export type Stage = "Investigating" | "Identified" | "Monitoring" | "Resolved" | "Update"
export const STAGES: readonly Stage[] = ["Investigating", "Identified", "Monitoring", "Resolved", "Update"]

export type Impact = "none" | "minor" | "major" | "critical"
const IMPACTS: readonly Impact[] = ["none", "minor", "major", "critical"]

export interface NoteUpdate {
  at: string
  stage: Stage
  /** Components the update names, with their state at that time. */
  components: { name: string; state: ComponentState }[]
  text: string
}

export interface Note {
  /** From the file name, such as 2026-11-20-database-upgrade. */
  id: string
  type: "maintenance" | "incident" | "notice"
  title: string
  components: string[]
  /** For a notice without a start, when it was published. */
  start: string
  end?: string
  /** Ids of detected incidents this note explains. */
  detected: string[]
  /** Incidents only. */
  impact?: Impact
  /** The Markdown before the first update. */
  body: string
  updates: NoteUpdate[]
}

export interface PublicNotes {
  format: typeof NOTES_FORMAT
  writtenAt: string
  notes: Note[]
}

export interface NoteProblem {
  file: string
  /** The header field or Markdown construct it's about. */
  field: string
  message: string
  fix?: string
}

const HEADER_KEYS = ["type", "title", "component", "components", "start", "end", "detected", "impact"]
const UPDATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*UTC\s*(.*?)\s*$/
const COMPONENTS_LINE = /^\s*Components:\s*(.*)$/i
const TYPES = ["maintenance", "incident", "notice"] as const

/**
 * Parses one note. Problems are errors: a note with any isn't published.
 * `now` is the publication time, the start of a notice that doesn't give one.
 */
export function parseNote(file: string, text: string, config: Config, now?: Date): { note: Note | null; errors: NoteProblem[]; warnings: NoteProblem[] } {
  const errors: NoteProblem[] = []
  const err = (field: string, message: string, fix?: string) => errors.push({ file, field, message, ...(fix ? { fix } : {}) })
  const id = file.replace(/^.*\//, "").replace(/\.md$/i, "")

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) {
    err("header", "has no header between --- lines.", "Start the file with ---, then type, title, components, start and end on their own lines, then ---.")
    return { note: null, errors, warnings: [] }
  }
  const header: Record<string, string> = {}
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (!kv) {
      err("header", `has a line that isn't "key: value": ${JSON.stringify(line)}.`)
      continue
    }
    const key = kv[1] ?? ""
    if (!HEADER_KEYS.includes(key)) err(key, "isn't a header field.", `Use ${HEADER_KEYS.join(", ")}.`)
    header[key] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "")
  }

  const type = TYPES.find((t) => t === header.type)
  if (!type) err("type", header.type ? `is "${header.type}".` : "is missing.", "Set type to maintenance, incident or notice.")
  const title = header.title ?? ""
  if (!title) err("title", "is missing.", "Give the note a title people will read on the status page.")
  const list = (s: string | undefined) => (s ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean)
  const components = [...list(header.components), ...list(header.component)]
  if (!components.length && type !== "notice") err("components", "is missing.", "Name the components it affects, separated by commas.")
  const known = new Set(config.components.map((c) => c.name))
  for (const c of components) if (!known.has(c)) err("components", `"${c}" isn't a component in the config.`, `Use one of: ${[...known].join(", ")}.`)

  const time = (key: "start" | "end", required: boolean) => {
    const value = header[key]
    if (!value) {
      if (required) err(key, "is missing.", "Write it as an ISO time with a zone, such as 2026-11-20T02:00:00Z.")
      return undefined
    }
    const ms = Date.parse(value)
    if (Number.isNaN(ms) || !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
      err(key, `"${value}" isn't a time with a zone.`, "Write it as an ISO time, such as 2026-11-20T02:00:00Z.")
      return undefined
    }
    return new Date(ms).toISOString()
  }
  const start = time("start", type !== "notice") ?? (type === "notice" && !header.start ? now?.toISOString() : undefined)
  if (type === "notice" && !header.start && !now) err("start", "is missing.", "Give the notice a start, or publish it with belltower notes push.")
  const end = time("end", type === "maintenance")
  if (start && end && Date.parse(end) <= Date.parse(start)) err("end", "is before start.", "Check the two times and their zones.")
  if (type !== "incident" && header.detected) err("detected", "only applies to incident notes.")
  if (type !== "incident" && header.impact) err("impact", "only applies to incident notes.")
  const impact = header.impact ? IMPACTS.find((i) => i === header.impact?.toLowerCase()) : "minor"
  if (!impact) err("impact", `is "${header.impact}".`, `Use one of: ${IMPACTS.join(", ")}.`)

  // The body, split into the summary and the timed updates.
  const lines = (match[2] ?? "").split(/\r?\n/)
  const updates: NoteUpdate[] = []
  const body: string[] = []
  let current: { at: string; stage: Stage; lines: string[] } | null = null
  const finishUpdate = () => {
    if (!current) return
    const lines = current.lines.join("\n").trim().split("\n")
    const named = COMPONENTS_LINE.exec(lines[0] ?? "")
    const states = named ? componentStates(named[1] ?? "", current.at) : []
    updates.push({ at: current.at, stage: current.stage, components: states, text: (named ? lines.slice(1) : lines).join("\n").trim() })
  }
  const byWord = new Map(Object.entries(STATE_WORDS).map(([state, word]) => [word.toLowerCase(), state as ComponentState]))
  const componentStates = (text: string, at: string) =>
    text.split(",").flatMap((part) => {
      const m = /^\s*(.+?)\s*\(\s*(.+?)\s*\)\s*$/.exec(part)
      const where = `the update at ${at.slice(0, 16).replace("T", " ")} UTC`
      if (!m) {
        err("components", `In ${where}, "${part.trim()}" isn't "Name (State)".`, "Write each as the component and its state in brackets, such as API (Degraded performance).")
        return []
      }
      const name = m[1] ?? ""
      const state = byWord.get((m[2] ?? "").toLowerCase())
      if (!known.has(name)) err("components", `In ${where}, "${name}" isn't a component in the config.`, `Use one of: ${[...known].join(", ")}.`)
      if (!state) err("components", `In ${where}, "${m[2]}" isn't a component state.`, `Use one of: ${Object.values(STATE_WORDS).join(", ")}.`)
      return known.has(name) && state ? [{ name, state }] : []
    })
  for (const line of lines) {
    const u = UPDATE_HEADING.exec(line)
    if (u) {
      finishUpdate()
      const at = new Date(`${u[1]}T${u[2]}:00Z`).toISOString()
      const word = (u[3] ?? "").trim()
      const stage = word ? STAGES.find((s) => s.toLowerCase() === word.toLowerCase()) : "Update"
      if (!stage) err("stage", `The update at ${u[1]} ${u[2]} UTC has the stage "${word}".`, `Use one of: ${STAGES.join(", ")}, or leave it out for Update.`)
      current = { at, stage: stage ?? "Update", lines: [] }
    } else if (current) current.lines.push(line)
    else body.push(line)
  }
  finishUpdate()

  const warnings = lintMarkdown(file, match[2] ?? "")
  if (errors.length || !type || !start) return { note: null, errors, warnings }
  return {
    note: {
      id,
      type,
      title,
      components: [...new Set(components)],
      start,
      ...(end ? { end } : {}),
      detected: list(header.detected),
      ...(type === "incident" && impact ? { impact } : {}),
      body: body.join("\n").trim(),
      updates: updates.sort((a, b) => a.at.localeCompare(b.at)),
    },
    errors,
    warnings,
  }
}

/**
 * Accessibility warnings for a note's Markdown (docs/direction.md, item 1).
 * Warnings, not errors: the notes are the deployment's own words.
 */
export function lintMarkdown(file: string, markdown: string): NoteProblem[] {
  const warnings: NoteProblem[] = []
  const warn = (field: string, message: string, fix: string) => warnings.push({ file, field, message, fix })
  for (const m of markdown.matchAll(/!\[\s*\]\(([^)]*)\)/g)) {
    warn("image", `The image ${m[1]} has no alt text.`, "Describe it between the brackets: ![What the image shows](...).")
  }
  for (const m of markdown.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g)) {
    const text = (m[1] ?? "").trim()
    if (/^(click )?here$|^(this|link|more|read more)$/i.test(text)) warn("link", `A link's text is "${text}".`, "Say where the link goes, such as [the upgrade plan](...).")
    else if (/^https?:\/\//i.test(text)) warn("link", `A link's text is the bare URL ${text}.`, "Say where the link goes in words.")
  }
  let last = 1
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^(#{1,6})\s/.exec(line)
    if (!h) continue
    const level = h[1]?.length ?? 1
    if (level > last + 1) warn("heading", `A level ${level} heading follows level ${last}: "${line.trim()}".`, `Use level ${last + 1}, or add the levels between.`)
    last = level
  }
  if (/<table[\s>]/i.test(markdown) && !/<th[\s>]/i.test(markdown)) warn("table", "An HTML table has no header cells.", "Mark the header row with <th>, or use a Markdown table.")
  return warnings
}

/** Parses every note; publishes only if none has an error. */
export function buildNotes(files: readonly { file: string; text: string }[], config: Config, now: Date): { notes: PublicNotes | null; errors: NoteProblem[]; warnings: NoteProblem[] } {
  const errors: NoteProblem[] = []
  const warnings: NoteProblem[] = []
  const notes: Note[] = []
  const ids = new Set<string>()
  for (const { file, text } of files) {
    const parsed = parseNote(file, text, config, now)
    errors.push(...parsed.errors)
    warnings.push(...parsed.warnings)
    if (!parsed.note) continue
    if (ids.has(parsed.note.id)) errors.push({ file, field: "file name", message: `Another note is also named ${parsed.note.id}.`, fix: "Rename one of the files." })
    ids.add(parsed.note.id)
    notes.push(parsed.note)
  }
  notes.sort((a, b) => b.start.localeCompare(a.start))
  return { notes: errors.length ? null : { format: NOTES_FORMAT, writtenAt: now.toISOString(), notes }, errors, warnings }
}

/** Maintenance windows from the published notes, in the shape availability wants. */
export function maintenanceWindows(notes: PublicNotes | null): { component: string; start: string; end: string }[] {
  if (!notes) return []
  return notes.notes.filter((n) => n.type === "maintenance" && n.end).flatMap((n) => n.components.map((component) => ({ component, start: n.start, end: n.end ?? n.start })))
}

/** Components in maintenance at a moment. */
export function inMaintenance(notes: PublicNotes | null, at: Date): Set<string> {
  const t = at.getTime()
  return new Set(maintenanceWindows(notes).filter((w) => Date.parse(w.start) <= t && t < Date.parse(w.end)).map((w) => w.component))
}
