import type { PublicPage, PublicStatus } from "./decide.ts"
import type { Note, PublicNotes, Stage } from "./notes.ts"
import { STATE_WORDS, worst, type ComponentState } from "./states.ts"

/*
 * summary.json and the feeds (docs/spec.md, "Machine-readable status"),
 * built from the public files alone, like the rest of the page. summary.json
 * follows the field names and values status page widgets and aggregators
 * already read, so they work with a Belltower page unchanged.
 */

/** What the page builder has read from public/. */
export interface PageInput {
  status: PublicStatus
  notes: PublicNotes | null
  page: PublicPage
  /** Where the page is served, ending in "/", such as https://status.example.com/. */
  siteUrl: string
  now: Date
}

/** Addresses of the page's own files, relative to its root. */
export const pagePaths = {
  incident: (id: string) => `incidents/${id}.html`,
  group: (slug: string) => `${slug}.html`,
}

/** Lowercase letters, digits and "-", for file names and ids. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group"
  )
}

const COMPONENT_STATUS: Record<ComponentState, string> = {
  operational: "operational",
  degraded: "degraded_performance",
  partial: "partial_outage",
  major: "major_outage",
  maintenance: "under_maintenance",
}

const INDICATOR: Record<ComponentState, string> = { operational: "none", degraded: "minor", partial: "major", major: "critical", maintenance: "maintenance" }

/** The overall state as a sentence, as the page's headline says it. */
export function headline(state: ComponentState): string {
  switch (state) {
    case "operational":
      return "All services are online"
    case "degraded":
      return "Some services are slow"
    case "partial":
      return "Some services are down"
    case "major":
      return "A service is down"
    case "maintenance":
      return "Maintenance in progress"
  }
}

/** The stage an incident note is at: its latest update's, skipping plain updates. */
export function noteStage(note: Note): Stage {
  for (let i = note.updates.length - 1; i >= 0; i--) {
    const stage = note.updates[i]?.stage
    if (stage && stage !== "Update") return stage
  }
  return note.end ? "Resolved" : "Investigating"
}

function maintenanceStatus(note: Note, now: Date): "scheduled" | "in_progress" | "completed" {
  if (now.getTime() < Date.parse(note.start)) return "scheduled"
  return note.end && now.getTime() >= Date.parse(note.end) ? "completed" : "in_progress"
}

function isOpenIncident(note: Note, now: Date): boolean {
  return note.type === "incident" && Date.parse(note.start) <= now.getTime() && (!note.end || Date.parse(note.end) > now.getTime()) && noteStage(note) !== "Resolved"
}

export function buildSummary(input: PageInput): unknown {
  const { status, notes, page, siteUrl, now } = input
  const pageId = slug(page.page.name)
  const updated = status.writtenAt
  const info = new Map(page.components.map((c) => [c.name, c]))
  const groups = [...new Set(page.components.map((c) => c.group).filter((g): g is string => g !== undefined))]
  const component = (name: string, position: number) => {
    const c = info.get(name)
    const state = status.components.find((s) => s.name === name)?.state ?? "operational"
    return {
      id: slug(name),
      name,
      status: COMPONENT_STATUS[state],
      created_at: updated,
      updated_at: updated,
      position,
      description: c?.description ?? null,
      showcase: true,
      start_date: null,
      group_id: c?.group ? slug(c.group) : null,
      page_id: pageId,
      group: false,
      only_show_if_degraded: false,
    }
  }
  const all = notes?.notes ?? []
  const explained = new Set(all.flatMap((n) => n.detected))
  const updatesOf = (note: Note) =>
    [...note.updates].reverse().map((u, i) => ({
      id: `${note.id}-${note.updates.length - i}`,
      status: u.stage === "Update" ? noteStage(note).toLowerCase() : u.stage.toLowerCase(),
      body: u.text,
      incident_id: note.id,
      created_at: u.at,
      updated_at: u.at,
      display_at: u.at,
      affected_components: u.components.map((c) => ({ code: slug(c.name), name: c.name, new_status: COMPONENT_STATUS[c.state] })),
    }))
  const noteComponents = (note: Note) => note.components.map((name) => component(name, page.components.findIndex((c) => c.name === name) + 1))
  const updatedAt = (note: Note) => note.updates.at(-1)?.at ?? note.start

  const incidents = [
    ...all
      .filter((n) => isOpenIncident(n, now))
      .map((n) => ({
        id: n.id,
        name: n.title,
        status: noteStage(n).toLowerCase(),
        created_at: n.start,
        updated_at: updatedAt(n),
        monitoring_at: n.updates.find((u) => u.stage === "Monitoring")?.at ?? null,
        resolved_at: null,
        impact: n.impact ?? "minor",
        shortlink: new URL(pagePaths.incident(n.id), siteUrl).href,
        started_at: n.start,
        page_id: pageId,
        incident_updates: updatesOf(n),
        components: noteComponents(n),
      })),
    ...status.incidents
      .filter((i) => !explained.has(i.id))
      .map((i) => ({
        id: i.id,
        name: "Detected outage",
        status: "investigating",
        created_at: i.startedAt,
        updated_at: i.startedAt,
        monitoring_at: null,
        resolved_at: null,
        impact: "major",
        shortlink: new URL(pagePaths.incident(i.id), siteUrl).href,
        started_at: i.startedAt,
        page_id: pageId,
        incident_updates: [],
        components: i.components.map((name) => component(name, page.components.findIndex((c) => c.name === name) + 1)),
      })),
  ]

  const maintenances = all
    .filter((n) => n.type === "maintenance" && maintenanceStatus(n, now) !== "completed")
    .map((n) => ({
      id: n.id,
      name: n.title,
      status: maintenanceStatus(n, now),
      created_at: n.start,
      updated_at: updatedAt(n),
      monitoring_at: null,
      resolved_at: null,
      impact: "maintenance",
      shortlink: new URL(pagePaths.incident(n.id), siteUrl).href,
      started_at: n.start,
      page_id: pageId,
      scheduled_for: n.start,
      scheduled_until: n.end ?? null,
      incident_updates: updatesOf(n),
      components: noteComponents(n),
    }))

  return {
    page: { id: pageId, name: page.page.name, url: siteUrl, time_zone: "Etc/UTC", updated_at: updated },
    status: { indicator: INDICATOR[status.overall], description: headline(status.overall) },
    components: [
      ...page.components.map((c, i) => component(c.name, i + 1)),
      ...groups.map((g, i) => ({
        id: slug(g),
        name: g,
        status: COMPONENT_STATUS[worst(page.components.filter((c) => c.group === g).map((c) => status.components.find((s) => s.name === c.name)?.state ?? "operational"))],
        created_at: updated,
        updated_at: updated,
        position: page.components.length + i + 1,
        description: null,
        showcase: false,
        start_date: null,
        group_id: null,
        page_id: pageId,
        group: true,
        only_show_if_degraded: false,
        components: page.components.filter((c) => c.group === g).map((c) => slug(c.name)),
      })),
    ],
    incidents,
    scheduled_maintenances: maintenances,
  }
}

/** One feed entry: an incident or maintenance note. */
interface Entry {
  id: string
  title: string
  url: string
  published: string
  updated: string
  text: string
}

function entries(input: PageInput): Entry[] {
  const notes = (input.notes?.notes ?? []).filter((n) => n.type !== "notice")
  const published = (n: Note) => (input.notes && n.start > input.notes.writtenAt ? input.notes.writtenAt : n.start)
  return notes
    .map((n) => {
      const kind = n.type === "maintenance" ? "Maintenance" : "Incident"
      const stage = n.type === "incident" ? noteStage(n) : { scheduled: "Scheduled", in_progress: "In progress", completed: "Completed" }[maintenanceStatus(n, input.now)]
      const lines = [
        `${kind}, ${stage}. Affects ${n.components.join(", ") || "no components"}.`,
        ...(n.body ? ["", n.body] : []),
        ...[...n.updates].reverse().flatMap((u) => ["", `${u.stage} at ${u.at.slice(0, 16).replace("T", " ")} UTC`, ...(u.components.length ? [`Components: ${u.components.map((c) => `${c.name} (${STATE_WORDS[c.state]})`).join(", ")}`] : []), u.text]),
      ]
      return {
        id: new URL(pagePaths.incident(n.id), input.siteUrl).href,
        title: `${n.title} (${stage})`,
        url: new URL(pagePaths.incident(n.id), input.siteUrl).href,
        // Upcoming maintenance counts from when it was published, never from a future time.
        published: published(n),
        updated: n.updates.at(-1)?.at ?? published(n),
        text: lines.join("\n"),
      }
    })
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export function buildFeeds(input: PageInput): { atom: string; rss: string; json: string } {
  const list = entries(input)
  const name = `${input.page.page.name} status`
  const updated = list[0]?.updated ?? input.status.writtenAt
  const atom = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xml(name)}</title>`,
    `  <id>${xml(input.siteUrl)}</id>`,
    `  <link href="${xml(input.siteUrl)}"/>`,
    `  <link rel="self" href="${xml(new URL("feed.atom", input.siteUrl).href)}"/>`,
    `  <updated>${updated}</updated>`,
    ...list.map((e) =>
      [
        "  <entry>",
        `    <title>${xml(e.title)}</title>`,
        `    <id>${xml(e.id)}</id>`,
        `    <link href="${xml(e.url)}"/>`,
        `    <published>${e.published}</published>`,
        `    <updated>${e.updated}</updated>`,
        `    <author><name>${xml(input.page.page.name)}</name></author>`,
        `    <content type="text">${xml(e.text)}</content>`,
        "  </entry>",
      ].join("\n"),
    ),
    "</feed>",
    "",
  ].join("\n")
  const rss = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xml(name)}</title>`,
    `    <link>${xml(input.siteUrl)}</link>`,
    `    <description>${xml(`Incidents and maintenance for ${input.page.page.name}.`)}</description>`,
    `    <atom:link href="${xml(new URL("feed.rss", input.siteUrl).href)}" rel="self" type="application/rss+xml"/>`,
    `    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`,
    ...list.map((e) =>
      [
        "    <item>",
        `      <title>${xml(e.title)}</title>`,
        `      <link>${xml(e.url)}</link>`,
        `      <guid isPermaLink="true">${xml(e.id)}</guid>`,
        `      <pubDate>${new Date(e.updated).toUTCString()}</pubDate>`,
        `      <description>${xml(e.text)}</description>`,
        "    </item>",
      ].join("\n"),
    ),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n")
  const json = JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: name,
      home_page_url: input.siteUrl,
      feed_url: new URL("feed.json", input.siteUrl).href,
      description: `Incidents and maintenance for ${input.page.page.name}.`,
      authors: [{ name: input.page.page.name }],
      items: list.map((e) => ({ id: e.id, url: e.url, title: e.title, content_text: e.text, date_published: e.published, date_modified: e.updated })),
    },
    null,
    2,
  )
  return { atom, rss, json }
}
