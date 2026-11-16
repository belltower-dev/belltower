import type { DayFigure, PublicHistory } from "../availability.ts"
import type { PublicPage, PublicStatus } from "../decide.ts"
import { noteStage, slug } from "../feeds.ts"
import type { Impact, Note, PublicNotes, Stage } from "../notes.ts"
import { worst, type ComponentState } from "../states.ts"

/*
 * What the pages show, worked out once from the public files: groups and
 * their components with 90 days each, every incident (from notes, and
 * detected ones no note explains), maintenance and notices.
 */

/** A day takes its worst state, in the same order as the overall state. */
export type DayState = ComponentState | "nodata"

export interface Day extends DayFigure {
  state: DayState
}

export interface ComponentView {
  name: string
  description?: string
  link?: string
  target?: number
  state: ComponentState
  days: Day[]
  hours: { hour: string; responseMs: number | null }[]
  month: { month: string; availability: number | null }
}

export interface GroupView {
  name: string
  slug: string
  state: ComponentState
  components: ComponentView[]
}

export interface IncidentView {
  id: string
  /** From a note, or detected from the checks with no note. */
  noted: boolean
  title: string
  start: string
  end?: string
  open: boolean
  stage: Stage
  impact: Impact
  /** Components named, with the state the latest update gives each. */
  components: { name: string; state: ComponentState | null }[]
  body: string
  /** Newest first. */
  updates: Note["updates"]
  /** For a detected incident: minutes down, when the history can say. */
  downMinutes?: number
}

export interface MaintenanceView {
  note: Note
  status: "In progress" | "Scheduled" | "Completed"
}

export interface PageModel {
  page: PublicPage["page"]
  status: PublicStatus
  now: Date
  groups: GroupView[]
  components: ComponentView[]
  incidents: IncidentView[]
  maintenance: MaintenanceView[]
  notices: Note[]
  /** Group slug by component name. */
  groupOf: Map<string, GroupView>
}

const MINUTE = 60_000
const DAY = 86_400_000
/** File names the page uses itself, which a group's page mustn't take. */
const RESERVED = new Set(["index", "incidents", "maintenance", "summary", "feed", "llms", "status", "history", "page", "notes", "reports", "style"])

export function dayState(d: DayFigure): DayState {
  if (d.uptime === null) return "nodata"
  if (d.majorMinutes > 0) return "major"
  if (d.partialMinutes > 0) return "partial"
  // Downtime with no state minutes: a day recorded before decide() counted them.
  if (d.downMinutes > 0) return "major"
  if (d.degradedMinutes > 0) return "degraded"
  if (d.maintenanceMinutes > 0) return "maintenance"
  return "operational"
}

/** The start time an incident id carries: the minute after the key, such as home-202611151001. */
export function startFromId(id: string): string | null {
  const m = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` : null
}

export function buildModel(input: { status: PublicStatus; history: PublicHistory | null; notes: PublicNotes | null; page: PublicPage; now: Date }): PageModel {
  const { status, history, notes, page, now } = input
  const t = now.getTime()
  const stateOf = new Map(status.components.map((c) => [c.name, c.state]))
  const historyOf = new Map((history?.components ?? []).map((c) => [c.name, c]))

  const components: ComponentView[] = page.components.map((c) => {
    const h = historyOf.get(c.name)
    return {
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.link !== undefined ? { link: c.link } : {}),
      ...(c.target !== undefined ? { target: c.target } : {}),
      state: stateOf.get(c.name) ?? "operational",
      days: (h?.days ?? []).map((d) => ({ ...d, state: dayState(d) })),
      hours: h?.hours ?? [],
      month: h?.month ?? { month: now.toISOString().slice(0, 7), availability: null },
    }
  })

  // Groups in config order; components without one share a group.
  const named = [...new Set(page.components.map((c) => c.group).filter((g): g is string => g !== undefined))]
  const ungrouped = page.components.filter((c) => c.group === undefined).map((c) => c.name)
  const taken = new Set<string>()
  const slugFor = (name: string) => {
    let s = slug(name)
    if (RESERVED.has(s)) s = `${s}-group`
    while (taken.has(s)) s = `${s}-2`
    taken.add(s)
    return s
  }
  const groups: GroupView[] = []
  for (const name of named) {
    const members = components.filter((c) => page.components.find((p) => p.name === c.name)?.group === name)
    groups.push({ name, slug: slugFor(name), state: worst(members.map((m) => m.state)), components: members })
  }
  if (ungrouped.length) {
    const members = components.filter((c) => ungrouped.includes(c.name))
    const name = named.length ? "Other services" : "Services"
    groups.push({ name, slug: slugFor(name), state: worst(members.map((m) => m.state)), components: members })
  }
  const groupOf = new Map(groups.flatMap((g) => g.components.map((c) => [c.name, g] as const)))

  const all = notes?.notes ?? []
  const explained = new Set(all.flatMap((n) => n.detected))
  const incidents: IncidentView[] = []
  for (const n of all.filter((n) => n.type === "incident" && Date.parse(n.start) <= t)) {
    const stage = noteStage(n)
    const latest = new Map<string, ComponentState>()
    for (const u of n.updates) for (const c of u.components) latest.set(c.name, c.state)
    incidents.push({
      id: n.id,
      noted: true,
      title: n.title,
      start: n.start,
      ...(n.end ? { end: n.end } : {}),
      open: stage !== "Resolved" && (!n.end || Date.parse(n.end) > t),
      stage,
      impact: n.impact ?? "minor",
      components: n.components.map((name) => ({ name, state: latest.get(name) ?? null })),
      body: n.body,
      updates: [...n.updates].reverse(),
    })
  }
  const seen = new Set(incidents.map((i) => i.id))
  for (const i of status.incidents) {
    if (explained.has(i.id) || seen.has(i.id)) continue
    seen.add(i.id)
    incidents.push({
      id: i.id,
      noted: false,
      title: "Detected outage",
      start: i.startedAt,
      open: true,
      stage: "Investigating",
      impact: "major",
      components: i.components.map((name) => ({ name, state: stateOf.get(name) ?? "major" })),
      body: "",
      updates: [],
    })
  }
  // Past detected incidents, from the days in the history.
  const past = new Map<string, { components: Set<string>; downMinutes?: number }>()
  for (const c of components) {
    for (const d of c.days) {
      for (const id of d.incidents) {
        if (explained.has(id) || seen.has(id)) continue
        const entry = past.get(id) ?? { components: new Set<string>() }
        entry.components.add(c.name)
        if (d.incidents.length === 1) entry.downMinutes = Math.max(entry.downMinutes ?? 0, d.downMinutes)
        past.set(id, entry)
      }
    }
  }
  for (const [id, entry] of past) {
    const start = startFromId(id)
    if (!start) continue
    incidents.push({
      id,
      noted: false,
      title: "Detected outage",
      start,
      ...(entry.downMinutes ? { end: new Date(Date.parse(start) + entry.downMinutes * MINUTE).toISOString(), downMinutes: entry.downMinutes } : {}),
      open: false,
      stage: "Resolved",
      impact: "major",
      components: [...entry.components].map((name) => ({ name, state: null })),
      body: "",
      updates: [],
    })
  }
  incidents.sort((a, b) => b.start.localeCompare(a.start))

  const maintenance: MaintenanceView[] = all
    .filter((n) => n.type === "maintenance")
    .map((note) => ({
      note,
      status: t < Date.parse(note.start) ? ("Scheduled" as const) : note.end && t >= Date.parse(note.end) ? ("Completed" as const) : ("In progress" as const),
    }))
    .sort((a, b) => a.note.start.localeCompare(b.note.start))

  const notices = all.filter((n) => n.type === "notice" && Date.parse(n.start) <= t && (!n.end || Date.parse(n.end) > t))

  return { page: page.page, status, now, groups, components, incidents, maintenance, notices, groupOf }
}

/** Incidents in the last `days` days, or open. */
export function recent(model: PageModel, days: number): IncidentView[] {
  const since = model.now.getTime() - days * DAY
  return model.incidents.filter((i) => i.open || Date.parse(i.start) >= since)
}
