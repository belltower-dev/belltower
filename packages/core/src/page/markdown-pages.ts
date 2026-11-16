import { pagePaths } from "../feeds.ts"
import { STATE_WORDS } from "../states.ts"
import type { ComponentView, DayState, GroupView, IncidentView, MaintenanceView, PageModel } from "./model.ts"
import { DAY_WORDS, dayLabel, minutes, pct, situation, uptime90, utcDateTime } from "./pages.ts"

/*
 * A Markdown copy of each page (docs/spec.md, "Machine-readable status"),
 * for agents and scripts that would rather not parse HTML. The 90-day bars
 * become a line of symbols with a legend in words.
 */

const SYMBOL: Record<DayState, string> = { operational: "+", degraded: "~", partial: "/", major: "x", maintenance: "=", nodata: "." }
const LEGEND = "Days, oldest first: `+` Operational, `~` Degraded performance, `/` Partial outage, `x` Major outage, `=` Maintenance, `.` No data."
const md = (path: string) => path.replace(/\.html$/, ".md")

function componentLines(c: ComponentView): string[] {
  const up = uptime90(c.days)
  return [
    `- **${c.name}**: ${STATE_WORDS[c.state]}${up === null ? "" : `, ${pct(up)} uptime over ${c.days.length} days`}${c.description ? `. ${c.description}` : ""}`,
    ...(c.days.length ? [`  \`${c.days.map((d) => SYMBOL[d.state]).join("")}\``] : []),
  ]
}

function incidentLine(i: IncidentView, prefix = ""): string {
  const names = i.components.map((c) => c.name).join(", ")
  return `- [${i.title}](${prefix}${md(pagePaths.incident(i.id))}): ${i.stage}, ${names}, started ${utcDateTime(i.start)}`
}

function regions(model: PageModel): string[] {
  const now = model.now.getTime()
  return model.status.regions.map((r) => {
    const fresh = r.lastResultsAt !== null && now - Date.parse(r.lastResultsAt) < 5 * 60_000
    return `- ${r.name}: ${fresh ? "writing results" : r.lastResultsAt ? `no results since ${utcDateTime(r.lastResultsAt)}` : "no results yet"}`
  })
}

export function statusMarkdown(model: PageModel): string {
  const ok = model.components.filter((c) => c.state === "operational").length
  const open = model.incidents.filter((i) => i.open)
  const live = model.maintenance.filter((m) => m.status === "In progress")
  return [
    `# ${model.page.name} status`,
    "",
    `${situation(model.components, model.status.overall)}. ${ok} of ${model.components.length} components operational. Last updated ${utcDateTime(model.status.writtenAt)}.`,
    ...model.notices.flatMap((n) => ["", `> **${n.title}**: ${n.body.replace(/\n+/g, " ")}`]),
    ...(open.length ? ["", "## Open incidents", "", ...open.map((i) => incidentLine(i))] : []),
    ...(live.length ? ["", "## Maintenance in progress", "", ...live.map((m) => maintenanceLine(m))] : []),
    "",
    "## Components",
    "",
    LEGEND,
    ...model.groups.flatMap((g) => ["", `### ${g.name}`, "", ...(model.groups.length > 1 ? [`State: ${STATE_WORDS[g.state]}. Details: [${g.name}](${md(pagePaths.group(g.slug))})`, ""] : []), ...g.components.flatMap(componentLines)]),
    "",
    "## Checked from",
    "",
    ...regions(model),
    "",
    "More: [Previous incidents](incidents.md), [Maintenance](maintenance.md), [status.json](status.json), [summary.json](summary.json), [Atom feed](feed.atom).",
    "",
  ].join("\n")
}

function maintenanceLine(m: MaintenanceView, prefix = ""): string {
  const n = m.note
  return `- [${n.title}](${prefix}${md(pagePaths.incident(n.id))}): ${m.status}, ${n.components.join(", ")}, ${utcDateTime(n.start)} to ${n.end ? utcDateTime(n.end) : "not set"}`
}

export function groupMarkdown(model: PageModel, g: GroupView): string {
  const names = new Set(g.components.map((c) => c.name))
  const items = model.incidents.filter((i) => i.components.some((c) => names.has(c.name)) && model.now.getTime() - Date.parse(i.start) < 15 * 86_400_000)
  return [
    `# ${g.name}`,
    "",
    `${situation(g.components, g.state)}. Last updated ${utcDateTime(model.status.writtenAt)}. [All services](index.md)`,
    "",
    "## Components",
    "",
    LEGEND,
    "",
    ...g.components.flatMap(componentLines),
    "",
    "## Incidents in the last 15 days",
    "",
    ...(items.length ? items.map((i) => incidentLine(i)) : ["None."]),
    "",
  ].join("\n")
}

export function componentsMarkdown(model: PageModel): string {
  const ok = model.components.filter((c) => c.state === "operational").length
  return [
    "# All components",
    "",
    `${ok} of ${model.components.length} components operational. Last updated ${utcDateTime(model.status.writtenAt)}. [Status](index.md)`,
    "",
    LEGEND,
    ...model.groups.flatMap((g) => ["", `## ${g.name}`, "", `State: ${STATE_WORDS[g.state]}.`, "", ...g.components.flatMap(componentLines)]),
    "",
  ].join("\n")
}

export function maintenanceMarkdown(model: PageModel): string {
  const live = model.maintenance.filter((m) => m.status === "In progress")
  const up = model.maintenance.filter((m) => m.status === "Scheduled")
  return ["# Maintenance", "", "## In progress", "", ...(live.length ? live.map((m) => maintenanceLine(m)) : ["None."]), "", "## Scheduled", "", ...(up.length ? up.map((m) => maintenanceLine(m)) : ["None."]), ""].join("\n")
}

export function incidentsMarkdown(model: PageModel): string {
  const since = model.now.getTime() - 90 * 86_400_000
  const items = model.incidents.filter((i) => i.open || Date.parse(i.start) >= since)
  return ["# Previous incidents", "", "The last 90 days, newest first.", "", ...(items.length ? items.map((i) => incidentLine(i)) : ["None."]), ""].join("\n")
}

export function incidentMarkdown(model: PageModel, i: IncidentView): string {
  const duration = i.open ? "ongoing" : i.end ? minutes((Date.parse(i.end) - Date.parse(i.start)) / 60_000) : "not recorded"
  return [
    `# ${i.title}`,
    "",
    `- Stage: ${i.stage}`,
    `- Impact: ${i.impact}`,
    `- Started: ${utcDateTime(i.start)}`,
    `- Duration: ${duration}`,
    `- Components: ${i.components.map((c) => (c.state ? `${c.name} (${STATE_WORDS[c.state]})` : c.name)).join(", ")}`,
    ...(i.body ? ["", i.body] : []),
    "",
    "## Updates",
    "",
    ...(i.updates.length
      ? i.updates.flatMap((u) => [`### ${u.stage}, ${utcDateTime(u.at)}`, "", ...(u.components.length ? [`Components: ${u.components.map((c) => `${c.name} (${STATE_WORDS[c.state]})`).join(", ")}`, ""] : []), u.text, ""])
      : [i.noted ? "None yet." : "None. Belltower detected this from its checks.", ""]),
    `[Previous incidents](../incidents.md)`,
    "",
  ].join("\n")
}

export function maintenanceNoteMarkdown(m: MaintenanceView): string {
  const n = m.note
  return [
    `# ${n.title}`,
    "",
    `- Maintenance: ${m.status}`,
    `- From: ${utcDateTime(n.start)}`,
    `- Until: ${n.end ? utcDateTime(n.end) : "not set"}`,
    `- Components: ${n.components.join(", ")}`,
    ...(n.body ? ["", n.body] : []),
    ...(n.updates.length ? ["", "## Updates", "", ...[...n.updates].reverse().flatMap((u) => [`### ${u.stage}, ${utcDateTime(u.at)}`, "", u.text, ""])] : [""]),
    `[Maintenance](../maintenance.md)`,
    "",
  ].join("\n")
}

export function llmsTxt(model: PageModel): string {
  return [
    `# ${model.page.name} status`,
    "",
    `> Current status, incidents and maintenance for ${model.page.name}. Every page has a Markdown copy at the same address ending in .md.`,
    "",
    "## Pages",
    "",
    "- [Status](index.md): the overall state, open incidents, maintenance in progress, and each service's components with 90 days of history",
    ...model.groups.map((g) => `- [${g.name}](${md(pagePaths.group(g.slug))}): ${g.name}'s components, their history, and incidents in the last 15 days`),
    "- [All components](components.md): every component of every service, with its state and 90 days of history",
    "- [Maintenance](maintenance.md): maintenance in progress and scheduled",
    "- [Previous incidents](incidents.md): incidents in the last 90 days, each linking to its own page",
    "",
    "## Data",
    "",
    "- [status.json](status.json): the current state of each component, open incidents, and each region's last results time, rewritten every minute",
    "- [history.json](history.json): 90 days of daily uptime, downtime, degraded minutes and response times per component",
    "- [summary.json](summary.json): the status in the shape status page widgets read",
    "- [Atom feed](feed.atom), [RSS feed](feed.rss), [JSON Feed](feed.json): incidents and maintenance, newest change first",
    "",
    `Day symbols in the Markdown copies: ${Object.entries(SYMBOL).map(([s, sym]) => `\`${sym}\` ${DAY_WORDS[s as DayState]}`).join(", ")}.`,
    "",
  ].join("\n")
}
