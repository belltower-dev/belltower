import { pagePaths } from "../feeds.ts"
import type { Note } from "../notes.ts"
import { STATE_WORDS, type ComponentState } from "../states.ts"
import { icon, type IconName } from "./icons.ts"
import { escapeHtml as esc, plainText, renderMarkdown } from "./markdown.ts"
import type { ComponentView, Day, DayState, GroupView, IncidentView, MaintenanceView, PageModel } from "./model.ts"

/*
 * The status page's HTML (docs/spec.md, "Status page"). Every page works
 * without JavaScript: disclosures are <details>, the subscribe panel is a
 * native popover, and times show in UTC. With JavaScript, times switch to
 * the viewer's zone with UTC alongside, incidents gain their age, the
 * light and dark choice is remembered, and the Status page checks
 * status.json each minute and offers a reload when something changed.
 */

const MINUTE = 60_000
const DAY = 86_400_000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export const DAY_WORDS: Record<DayState, string> = { ...STATE_WORDS, nodata: "No data" }
const DAY_ORDER: DayState[] = ["operational", "degraded", "partial", "major", "maintenance", "nodata"]
const IMPACT_WORDS = { none: "None", minor: "Minor", major: "Major", critical: "Critical" } as const

// ---------- Words, numbers and times ----------

const pad = (n: number) => String(n).padStart(2, "0")
export function utcDay(iso: string): string {
  const d = new Date(iso)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}
export function utcTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}
export function utcDateTime(iso: string): string {
  return `${utcDay(iso)}, ${utcTime(iso)}`
}
export const dayLabel = (key: string) => utcDay(`${key}T00:00:00Z`)
export const monthLabel = (key: string) => `${LONG_MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`

/** A time the browser rewrites into the viewer's zone. */
function time(iso: string, format: "datetime" | "time" = "datetime"): string {
  return `<time datetime="${esc(iso)}" data-format="${format}">${esc(format === "time" ? utcTime(iso) : utcDateTime(iso))}</time>`
}
/** "9 days ago", filled in by the browser so it's never stale. */
function age(iso: string): string {
  return `<span data-age="${esc(iso)}"></span>`
}

export function minutes(m: number): string {
  const total = Math.max(0, Math.round(m))
  const h = Math.floor(total / 60)
  const r = total % 60
  const hs = h ? `${h} hour${h === 1 ? "" : "s"}` : ""
  const rs = r || !h ? `${r} minute${r === 1 ? "" : "s"}` : ""
  return [hs, rs].filter(Boolean).join(" ")
}

/** Rounded down, so a down minute never shows as 100%. */
export function pct(n: number | null): string {
  if (n === null) return "No data"
  return n >= 100 ? "100%" : `${(Math.floor(n * 100) / 100).toFixed(2)}%`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** The situation in a sentence, for the headline. */
/**
 * The headline: short, and never a list of names, since the affected
 * services are listed right under it. "One service is down", "Some
 * services are slow", by the worst problem among them.
 */
export function situation(components: readonly { name: string; state: ComponentState }[], _fallback?: ComponentState): string {
  const hit = components.filter((c) => c.state !== "operational")
  if (!hit.length) return components.length === 1 ? `${components[0]?.name} is online` : "All services are online"
  const states = hit.map((c) => c.state)
  if (states.every((st) => st === "maintenance")) return "Maintenance in progress"
  const down = states.includes("major") || states.includes("partial")
  if (components.length === 1) return `${components[0]?.name} is ${down ? "down" : "slow"}`
  if (hit.length === 1) return `One service is ${down ? "down" : "slow"}`
  return `Some services are ${down ? "down" : "slow"}`
}

export function uptime90(days: readonly Day[]): number | null {
  const withData = days.filter((d) => d.uptime !== null)
  if (!withData.length) return null
  return withData.reduce((a, d) => a + (d.uptime ?? 0), 0) / withData.length
}

// ---------- Small shared pieces ----------

function stateIcon(state: ComponentState, cls = ""): string {
  return icon(state, `s-${state}${cls ? ` ${cls}` : ""}`)
}
function stateText(state: ComponentState): string {
  return `<span class="state">${stateIcon(state)}<span>${STATE_WORDS[state]}</span></span>`
}
function statePill(state: ComponentState): string {
  return `<span class="pill">${stateIcon(state, "icon-sm")}${STATE_WORDS[state]}</span>`
}
function stageBadge(stage: string): string {
  return `<span class="badge${stage === "Resolved" ? " badge-muted" : ""}">${stage === "Resolved" ? icon("check", "icon-sm") : ""}${esc(stage)}</span>`
}
function crumbs(root: string, items: [string, string?][]): string {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items
    .map(([label, href]) => (href ? `<li><a href="${root}${href}">${esc(label)}</a></li>` : `<li><span aria-current="page">${esc(label)}</span></li>`))
    .join("")}</ol></nav>`
}
function componentStates(states: readonly { name: string; state: ComponentState }[]): string {
  if (!states.length) return ""
  return `<p class="small row" style="justify-content:flex-start"><span class="muted">Components:</span>${states
    .map((c) => `<span class="state">${stateIcon(c.state, "icon-sm")}${esc(c.name)}: ${STATE_WORDS[c.state]}</span>`)
    .join("")}</p>`
}
function incidentHref(root: string, id: string) {
  return `${root}${pagePaths.incident(id)}`
}
function duration(i: IncidentView, now: Date): string {
  if (i.open) return `Ongoing, ${minutes((now.getTime() - Date.parse(i.start)) / MINUTE)} so far`
  if (!i.end) return "Not recorded"
  return minutes((Date.parse(i.end) - Date.parse(i.start)) / MINUTE)
}

// ---------- Layout ----------

interface Layout {
  title: string
  description: string
  /** "" for pages at the root, "../" for incidents/. */
  root: string
  /** This page's path, for its Markdown copy. */
  path: string
  nav: "status" | "maintenance" | "incidents" | null
  body: string
  /** Status page only: what to compare status.json with. */
  watch?: string
}

export function layout(model: PageModel, l: Layout): string {
  const p = model.page
  const r = l.root
  const md = l.path.replace(/\.html$/, ".md")
  // Relative image paths are relative to the page's root, wherever this page sits.
  const asset = (src: string) => esc(/^([a-z][a-z0-9+.-]*:|\/)/i.test(src) ? src : `${r}${src}`)
  const logo = p.logo
    ? `<img class="logo-light${p.logoDark ? " has-dark" : ""}" src="${asset(p.logo.src)}" alt="${esc(p.logo.alt)}" height="28">${p.logoDark ? `<img class="logo-dark" src="${asset(p.logoDark.src)}" alt="${esc(p.logoDark.alt)}" height="28">` : ""}`
    : ""
  const navLink = (key: Layout["nav"], href: string, label: string, ic: IconName) =>
    `<a href="${r}${href}"${l.nav === key ? ' aria-current="page"' : ""}>${icon(ic)}${label}</a>`
  const footerLinks = p.footer?.links.map((f) => `<a href="${esc(f.url)}">${esc(f.text)}</a>`).join("") ?? ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.title)}</title>
<meta name="description" content="${esc(l.description)}">
<link rel="stylesheet" href="${r}style.css">
<link rel="alternate" type="text/markdown" href="${r}${esc(md)}">
<link rel="alternate" type="application/atom+xml" title="${esc(p.name)} incidents and maintenance (Atom)" href="${r}feed.atom">
<link rel="alternate" type="application/rss+xml" title="${esc(p.name)} incidents and maintenance (RSS)" href="${r}feed.rss">
<link rel="alternate" type="application/feed+json" title="${esc(p.name)} incidents and maintenance (JSON Feed)" href="${r}feed.json">
${p.favicon ? `<link rel="icon" href="${asset(p.favicon)}">\n` : ""}<script>try{var m=localStorage.getItem("belltower-mode");if(m==="light"||m==="dark")document.documentElement.setAttribute("data-theme",m)}catch(e){}</script>
</head>
<body${l.watch ? ` data-watch="${esc(l.watch)}"` : ""}>
<a class="skip btn btn-outline btn-sm" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <div class="site-top">
      <a class="brand" href="${p.link ? esc(p.link) : `${r}index.html`}" aria-label="${p.link ? `Go to ${esc(p.name)}` : `${esc(p.name)} status, home`}">${logo}${p.logo?.wordmark ? "" : `<span>${esc(p.name)}</span>`}</a>
      <nav class="tabs" aria-label="Status pages">
        ${navLink("status", "index.html", "Status", "activity")}
        ${navLink("maintenance", "maintenance.html", "Maintenance", "maintenance")}
        ${navLink("incidents", "incidents.html", "Previous incidents", "clock")}
      </nav>
      <div class="top-actions">
        <button type="button" class="btn btn-primary btn-sm" popovertarget="subscribe">${icon("feed")}Subscribe to updates</button>
      </div>
    </div>
  </div>
</header>
<div id="subscribe" popover class="card">
  <div class="card-body">
    <h2>Get updates in a feed reader</h2>
    <p class="small muted">Each feed lists incidents and maintenance as they're posted.</p>
    <ul class="stack-sm small">
      <li><a href="${r}feed.atom">Atom feed</a></li>
      <li><a href="${r}feed.rss">RSS feed</a></li>
      <li><a href="${r}feed.json">JSON Feed</a></li>
    </ul>
    <button type="button" class="btn btn-outline btn-sm" popovertarget="subscribe" popovertargetaction="hide">Close</button>
  </div>
</div>
<main id="main" class="wrap">
${l.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="stack-sm">
      ${p.footer?.text ? `<p>${esc(p.footer.text)}</p>` : ""}
      <p class="footer-links muted">${footerLinks}${p.reportProblem ? `<a href="${esc(p.reportProblem)}">Report a problem</a>` : ""}<a href="${r}${esc(md)}">This page in Markdown</a></p>
      <p class="muted">Feeds: <a href="${r}feed.atom">Atom</a>, <a href="${r}feed.rss">RSS</a>, <a href="${r}feed.json">JSON Feed</a>. Times are in your time zone with UTC alongside.</p>
      ${p.poweredBy ? '<p class="muted">Powered by Belltower</p>' : ""}
    </div>
    <div class="mode">
      <label for="mode">Theme</label>
      <select id="mode">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  </div>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`
}

/** The page's only script. Everything it does is an addition; the page works without it. */
const SCRIPT = `(function(){
var root=document.documentElement,KEY="belltower-mode",sel=document.getElementById("mode");
// System by default: no data-theme, so the page follows the viewer's setting. Light or Dark is remembered on this device.
if(sel){var saved=null;try{saved=localStorage.getItem(KEY)}catch(e){}
sel.value=saved==="light"||saved==="dark"?saved:"system";
sel.addEventListener("change",function(){var v=sel.value;try{if(v==="system")localStorage.removeItem(KEY);else localStorage.setItem(KEY,v)}catch(e){}
if(v==="light"||v==="dark")root.setAttribute("data-theme",v);else root.removeAttribute("data-theme")})}
var tf=new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"});
var df=new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"});
var du=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
var tu=new Intl.DateTimeFormat("en-GB",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"UTC"});
document.querySelectorAll("time[data-format]").forEach(function(el){
var d=new Date(el.getAttribute("datetime"));if(isNaN(d)||d.getTimezoneOffset()===0)return;
var utc=tu.format(d)+" UTC";
if(el.getAttribute("data-format")==="time"){el.textContent=tf.format(d)+" ("+utc+")";return}
var sameDay=df.format(d)===du.format(d);
el.textContent=df.format(d)+", "+tf.format(d)+" ("+(sameDay?"":du.format(d)+", ")+utc+")"});
var now=Date.now();
document.querySelectorAll("[data-age]").forEach(function(el){
var ms=now-new Date(el.getAttribute("data-age")).getTime();if(isNaN(ms)||ms<0)return;
var m=Math.round(ms/60000),h=Math.round(m/60),d=Math.floor(ms/86400000);
el.textContent=", "+(m<60?m+" minute"+(m===1?"":"s")+" ago":h<24?h+" hour"+(h===1?"":"s")+" ago":d+" day"+(d===1?"":"s")+" ago")});
var watch=document.body.getAttribute("data-watch");
if(watch&&window.fetch){setInterval(function(){
fetch("status.json",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(s){
if(!s)return;var now=s.overall+"|"+s.components.map(function(c){return c.name+":"+c.state}).join(",");
if(now!==watch){var box=document.getElementById("changed");if(box&&!box.classList.contains("show")){box.classList.add("show");box.querySelector("p").textContent="The status has changed since this page was built. Reload to see it."}}
}).catch(function(){})},60000)}
})();`

// ---------- Blocks ----------

function regionsBlock(model: PageModel): string {
  const now = model.now.getTime()
  const regions = model.status.regions.map((r) => ({ ...r, fresh: r.lastResultsAt !== null && now - Date.parse(r.lastResultsAt) < 5 * MINUTE }))
  if (!regions.length) return ""
  const stalled = regions.filter((r) => !r.fresh)
  const summary = stalled.length
    ? `Checked from ${plural(regions.length, "region")}. ${list(stalled.map((r) => r.name))} ${stalled.length === 1 ? "has" : "have"} written no recent results.`
    : `Checked from ${plural(regions.length, "region")}, all writing results`
  // About Belltower itself, not the visitor's services: quiet, at the end of the page.
  return `<details class="quiet">
  <summary>${icon("globe", "icon-sm")}<span>${esc(summary)}</span>${icon("chevron-down", "icon-sm chev")}</summary>
  <div class="stack small">
    <p class="muted">Belltower checks every service once a minute from each region. A problem counts only when two regions confirm it, so one region failing alone changes no states.</p>
    <div class="table-wrap bordered"><table>
      <caption class="sr-only">Regions and when each last wrote results</caption>
      <thead><tr><th scope="col">Region</th><th scope="col">Results</th><th scope="col">Last results</th></tr></thead>
      <tbody>${regions
        .map(
          (r) => `<tr><th scope="row">${esc(r.name)}</th><td>${
            r.fresh ? `<span class="state">${icon("check", "icon-sm s-operational")}Writing results</span>` : `<span class="state">${icon("degraded", "icon-sm s-degraded")}${r.lastResultsAt ? "No results since " + time(r.lastResultsAt, "time") : "No results yet"}</span>`
          }</td><td>${r.lastResultsAt ? time(r.lastResultsAt) : "Never"}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </div>
</details>`
}

function openIncidentCard(model: PageModel, i: IncidentView, root: string): string {
  const u = i.updates[0]
  const latest = u
    ? `<div class="inset stack-sm"><p class="row small" style="justify-content:flex-start">${stageBadge(u.stage)}<span class="muted">${time(u.at)}</span></p><div class="prose">${renderMarkdown(u.text, 4)}</div>${componentStates(u.components)}</div>`
    : i.noted
      ? `<div class="inset prose">${renderMarkdown(i.body, 4)}</div>`
      : `<div class="inset small">Belltower detected this from its checks: ${esc(list(i.components.map((c) => c.name)))} ${i.components.length === 1 ? "is" : "are"} failing in more than one region. No update has been posted yet.</div>`
  return `<article class="card"><div class="card-body">
  <div class="row"><h3><a href="${incidentHref(root, i.id)}">${esc(i.title)}</a></h3><span class="badge badge-muted">Impact: ${IMPACT_WORDS[i.impact]}</span></div>
  ${latest}
  <div class="card-foot small"><span class="muted">Started ${time(i.start)}${age(i.start)}</span><a class="btn btn-outline btn-sm" href="${incidentHref(root, i.id)}">View incident${icon("arrow-right")}</a></div>
</div></article>`
}

function maintenanceCard(m: MaintenanceView, root: string): string {
  const n = m.note
  const live = m.status === "In progress"
  return `<article class="card"><div class="card-body">
  <div class="row"><h3 class="state" style="font-size:1rem">${icon("maintenance", "s-maintenance")}<a href="${incidentHref(root, n.id)}">${esc(n.title)}</a></h3><span class="badge${live ? "" : " badge-muted"}">${m.status}</span></div>
  ${n.body ? `<div class="prose">${renderMarkdown(n.body, 4)}</div>` : ""}
  <dl class="facts">
    <dt>From</dt><dd>${time(n.start)}</dd>
    <dt>Until</dt><dd>${n.end ? `${time(n.end)} (${minutes((Date.parse(n.end) - Date.parse(n.start)) / MINUTE)})` : "Not set"}</dd>
    <dt>Components</dt><dd>${n.components.map((c) => (live ? `<span class="state">${stateIcon("maintenance", "icon-sm")}${esc(c)}: Maintenance</span>` : esc(c))).join(", ")}</dd>
  </dl>
</div></article>`
}

function noticeBlock(n: Note): string {
  // Notices come before the headline, so their titles aren't headings: the h1 stays first.
  return `<section class="notice" aria-labelledby="notice-${esc(n.id)}" style="margin-top:0">
  ${icon("notice", "muted")}
  <div class="stack-sm"><p id="notice-${esc(n.id)}"><strong>${esc(n.title)}</strong></p>${n.body ? `<div class="prose small">${renderMarkdown(n.body, 3)}</div>` : ""}</div>
</section>`
}

/** Each affected component and its state, as a plain list under the headline. */
function affectedBlock(model: PageModel, root: string): string {
  const order: ComponentState[] = ["major", "partial", "degraded", "maintenance"]
  const hit = model.components.filter((c) => c.state !== "operational").sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
  if (!hit.length) return ""
  const single = model.groups.length === 1
  return `<section aria-labelledby="affected" class="affected">
  <h2 id="affected" class="sr-only">Affected services</h2>
  <ul>${hit
    .map((c) => {
      const g = model.groupOf.get(c.name)
      const name = single || !g ? esc(c.name) : `<a href="${root}${pagePaths.group(g.slug)}">${esc(c.name)}</a>`
      return `<li>${stateIcon(c.state)}<span>${name}: ${STATE_WORDS[c.state]}</span></li>`
    })
    .join("")}</ul>
</section>`
}

function headlineBlock(model: PageModel, text: string, state: ComponentState, extra = ""): string {
  return `<div>
  <h1 class="headline">${stateIcon(state)}<span>${esc(text)}</span></h1>
  <p class="meta">${extra}<span>Last updated ${time(model.status.writtenAt)}</span></p>
</div>`
}

// ---------- Components ----------

function barLabel(d: Day): string {
  const parts = [`${dayLabel(d.date)}: ${DAY_WORDS[d.state]}`]
  if (d.uptime !== null) parts.push(`${pct(d.uptime)} up`)
  if (d.majorMinutes) parts.push(`${minutes(d.majorMinutes)} major outage`)
  if (d.partialMinutes) parts.push(`${minutes(d.partialMinutes)} partial outage`)
  if (d.degradedMinutes) parts.push(`${minutes(d.degradedMinutes)} degraded`)
  if (d.maintenanceMinutes) parts.push(`${minutes(d.maintenanceMinutes)} maintenance`)
  if (d.uptime !== null) parts.push(d.incidents.length ? plural(d.incidents.length, "incident") : "no incidents")
  return parts.join(", ")
}

function daysSummary(days: readonly Day[]): string {
  const count = (s: DayState) => days.filter((d) => d.state === s).length
  const parts: string[] = []
  if (count("degraded")) parts.push(`${plural(count("degraded"), "day")} degraded`)
  if (count("partial")) parts.push(`${plural(count("partial"), "day")} with a partial outage`)
  if (count("major")) parts.push(`${plural(count("major"), "day")} with a major outage`)
  if (count("maintenance")) parts.push(`${plural(count("maintenance"), "day")} with maintenance`)
  const nodata = count("nodata")
  const base = parts.length ? `${parts.join(", ")}.` : days.length - nodata ? "Operational every day." : "No days recorded yet."
  return nodata && days.length - nodata ? `${base} No data for the ${plural(nodata, "day")} before monitoring began.` : base
}

function daysTable(model: PageModel, c: ComponentView, root: string): string {
  const rows = c.days.filter((d) => (d.state !== "operational" && d.state !== "nodata") || d.incidents.length).reverse()
  if (!rows.length) return '<p class="small">Every day with data was operational.</p>'
  const title = (id: string) => model.incidents.find((i) => i.id === id)?.title ?? "Detected outage"
  return `<div class="table-wrap"><table>
  <caption class="sr-only">${esc(c.name)}: days that weren't fully operational, newest first</caption>
  <thead><tr><th scope="col">Day</th><th scope="col">State</th><th scope="col" class="num">Uptime</th><th scope="col" class="num">Degraded</th><th scope="col">Incidents</th></tr></thead>
  <tbody>${rows
    .map(
      (d) => `<tr><td>${dayLabel(d.date)}</td><td><span class="state">${icon(d.state, `icon-sm s-${d.state}`)}${DAY_WORDS[d.state]}</span></td><td class="num">${pct(d.uptime)}</td><td class="num">${
        d.degradedMinutes ? minutes(d.degradedMinutes) : "None"
      }</td><td>${d.incidents.length ? d.incidents.map((id) => `<a href="${incidentHref(root, id)}">${esc(title(id))}</a>`).join(", ") : "None"}</td></tr>`,
    )
    .join("")}</tbody>
</table></div>`
}

function responseBlock(c: ComponentView): string {
  const hours = c.hours
  const known = hours.filter((h) => h.responseMs !== null)
  if (!known.length) return '<p class="small muted">No response times recorded in the last 24 hours.</p>'
  const max = Math.max(...known.map((h) => h.responseMs ?? 0))
  const last = known[known.length - 1]
  return `<div>
  <p class="small"><span class="muted">Median response time, ${last ? time(last.hour, "time") : ""} hour:</span> <span class="num" style="font-weight:500">${last?.responseMs} ms</span></p>
  <div class="chart" aria-hidden="true">${hours.map((h) => (h.responseMs === null ? '<span class="empty"></span>' : `<span style="height:${Math.max(4, Math.round(((h.responseMs ?? 0) / max) * 100))}%"></span>`)).join("")}</div>
  <div class="bar-scale"><span>24 hours ago</span><span>Now</span></div>
</div>`
}

function responseTable(c: ComponentView): string {
  return `<div class="table-wrap table-scroll"><table>
  <caption class="sr-only">${esc(c.name)}: median response time by hour, newest first</caption>
  <thead><tr><th scope="col">Hour starting</th><th scope="col" class="num">Median</th></tr></thead>
  <tbody>${[...c.hours].reverse().map((h) => `<tr><td>${time(h.hour, "time")}</td><td class="num">${h.responseMs === null ? "No data" : `${h.responseMs} ms`}</td></tr>`).join("")}</tbody>
</table></div>`
}

function monthBlock(model: PageModel, c: ComponentView): string {
  const key = c.month.month
  const inMonth = c.days.filter((d) => d.date.startsWith(key))
  const down = inMonth.reduce((a, d) => a + d.downMinutes, 0)
  const avail = c.month.availability
  if (c.target === undefined) return `<p class="small"><span class="muted">${monthLabel(key)} so far:</span> <span class="num">${pct(avail)}</span> available</p>`
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  const monthMinutes = new Date(Date.UTC(y, m, 0)).getUTCDate() * 1440
  const budget = monthMinutes * (1 - c.target / 100)
  const met = avail === null || avail >= c.target
  const used = budget > 0 ? Math.min(100, Math.round((down / budget) * 100)) : 100
  const id = `budget-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return `<div class="stack-sm">
  <div class="stats small">
    <div><p class="muted">Availability in ${monthLabel(key)}</p><p class="stat-value">${pct(avail)}</p><p class="muted">Target ${c.target}%. ${met ? "On target so far." : "Below target so far."}</p></div>
    <div><p class="muted">Downtime this month</p><p class="stat-value">${minutes(down)}</p><p class="muted">Degraded time doesn't count.</p></div>
    <div><p class="muted">Downtime budget left</p><p class="stat-value">${minutes(Math.max(0, budget - down))}</p><p class="muted">of ${minutes(budget)} the target allows</p></div>
  </div>
  <label for="${id}" class="small muted">Budget used: ${used}%</label>
  <progress id="${id}" value="${Math.min(down, budget).toFixed(1)}" max="${budget.toFixed(1)}">${used}%</progress>
</div>`
}

function componentRow(model: PageModel, c: ComponentView, root: string): string {
  const up = uptime90(c.days)
  const days = c.days
  const counts = DAY_ORDER.map((s) => [s, days.filter((d) => d.state === s).length] as const).filter(([, n]) => n)
  const barsLabel = `${c.name}, last ${days.length} days: ${counts.map(([s, n]) => `${n} ${DAY_WORDS[s].toLowerCase()}`).join(", ")}. The table below lists each day that wasn't fully operational.`
  return `<details>
  <summary><span class="name">${esc(c.name)}</span><span class="small muted num wide-only">${up === null ? "" : `${pct(up)} uptime`}</span>${stateText(c.state)}${icon("chevron-down", "chev")}</summary>
  <div class="stack">
    ${c.description || c.link ? `<p class="small muted">${c.description ? esc(c.description) : ""}${c.link ? `${c.description ? " " : ""}<a href="${esc(c.link)}">Open ${esc(c.name)}</a>` : ""}</p>` : ""}
    ${
      days.length
        ? `<div>
      <p class="row small"><span style="font-weight:500">Last ${days.length} days</span><span class="num">${up === null ? "No data" : `${pct(up)} uptime`}</span></p>
      <div class="bars" role="img" aria-label="${esc(barsLabel)}">${days.map((d, i) => `<span class="bar bar-${d.state}${i < days.length - 30 ? " early" : ""}" title="${esc(barLabel(d))}"></span>`).join("")}</div>
      <div class="bar-scale"><span class="narrow-only">30 days ago</span><span class="wide-only">${days.length} days ago</span><span>Today</span></div>
      <p class="small" style="margin-top:.5rem">${esc(daysSummary(days))}</p>
    </div>`
        : '<p class="small muted">No history yet.</p>'
    }
    ${responseBlock(c)}
    ${monthBlock(model, c)}
    <div class="stack-sm">
      <details class="sub"><summary>Days that weren't fully operational${icon("chevron-down", "chev")}</summary><div>${daysTable(model, c, root)}</div></details>
      <details class="sub"><summary>Response times, last 24 hours${icon("chevron-down", "chev")}</summary><div>${responseTable(c)}</div></details>
    </div>
  </div>
</details>`
}

function componentRows(model: PageModel, g: GroupView, root: string, headingId: string): string {
  return `<section aria-labelledby="${headingId}">
  <div class="section-head"><h2 id="${headingId}">Components</h2><p class="small muted">Open a component for its history</p></div>
  <div class="rows">${g.components.map((c) => componentRow(model, c, root)).join("")}</div>
</section>`
}

// ---------- Incidents by day ----------

const STAGE_ICON: Record<string, [IconName, string]> = {
  Resolved: ["operational", "s-operational"],
  Monitoring: ["eye", "muted"],
  Identified: ["partial", "muted"],
  Investigating: ["search", "muted"],
  Update: ["info", "muted"],
}

/** One update as a card on the timeline: its stage, time, words and the component states it gives. */
function updateItem(u: IncidentView["updates"][number], headingBase: number): string {
  const [name, cls] = STAGE_ICON[u.stage] ?? ["info", "muted"]
  return `<li><span class="tl-icon">${icon(name, cls)}</span><div class="tl-card stack-sm"><p class="small"><strong>${esc(u.stage)}</strong> <span class="muted">${time(u.at)}</span></p>${u.text ? `<div class="prose">${renderMarkdown(u.text, headingBase)}</div>` : ""}${componentStates(u.components)}</div></li>`
}

/** A card on the timeline for something that isn't a posted update. */
function noteItem(text: string, name: IconName = "nodata"): string {
  return `<li><span class="tl-icon">${icon(name, "muted")}</span><div class="tl-card small">${text}</div></li>`
}

function timeline(items: readonly string[]): string {
  return `<ol class="timeline">${items.join("")}</ol>`
}

/** An incident under its day on Previous incidents: the latest update, and the rest folded beneath. */
function entry(model: PageModel, i: IncidentView, root: string): string {
  const names = list(i.components.map((c) => c.name))
  const head = `<div class="row"><h4><a href="${incidentHref(root, i.id)}">${esc(i.title)}</a></h4>${stageBadge(i.stage)}</div>`
  if (!i.noted) {
    const what = i.downMinutes ? `down for ${minutes(i.downMinutes)}` : i.open ? `down since ${utcTime(i.start)}` : "down"
    return `<article class="stack-sm">${head}${timeline([noteItem(`${esc(names)}: ${what}. Belltower detected it from its checks; no update was posted.`)])}</article>`
  }
  const [u, ...rest] = i.updates
  return `<article class="stack-sm">
  ${head}
  <p class="small muted">${esc(names)}. Impact: ${IMPACT_WORDS[i.impact]}. ${esc(duration(i, model.now))}.</p>
  ${u ? timeline([updateItem(u, 5)]) : i.body ? timeline([noteItem(renderMarkdown(i.body, 5), "info")]) : ""}
  ${
    rest.length
      ? `<details class="earlier"><summary>${icon("nodata", "muted")}<span>${plural(rest.length, "previous update")}</span>${icon("chevron-down", "icon-sm chev")}</summary>${timeline(rest.map((r) => updateItem(r, 5)))}</details>`
      : ""
  }
</article>`
}

/** Past incidents as one list, newest first: only days that had one, so quiet days don't fill the page. */
function pastList(model: PageModel, items: readonly IncidentView[], root: string, days: number): string {
  const since = model.now.getTime() - days * DAY
  const recentItems = items.filter((i) => Date.parse(i.start) >= since)
  if (!recentItems.length) return `<p class="boxed small muted" style="margin-top:1rem">No incidents in the last ${days} days.</p>`
  return `<ul class="rows past" style="margin-top:1rem">${recentItems
    .map((i) => {
      const names = list(i.components.map((c) => c.name))
      const facts = i.noted
        ? `${esc(names)}. ${esc(duration(i, model.now))}. Impact: ${IMPACT_WORDS[i.impact]}.`
        : `${esc(names)}${i.downMinutes ? `, down for ${minutes(i.downMinutes)}` : ""}. Detected from checks; no update was posted.`
      return `<li>
  <time class="small muted" datetime="${esc(i.start)}">${utcDay(i.start)}</time>
  <div class="stack-sm"><h3><a href="${incidentHref(root, i.id)}">${esc(i.title)}</a></h3><p class="small muted">${facts}</p></div>
  ${stageBadge(i.stage)}
</li>`
    })
    .join("")}</ul>`
}

// ---------- Pages ----------

export function statusPage(model: PageModel): { html: string } {
  const root = ""
  const overall = model.status.overall
  const text = situation(model.components, overall)
  const open = model.incidents.filter((i) => i.open)
  const live = model.maintenance.filter((m) => m.status === "In progress")
  const week = model.incidents.filter((i) => !i.open && model.now.getTime() - Date.parse(i.start) < 7 * DAY)
  const single = model.groups.length === 1 ? model.groups[0] : undefined
  const watch = `${overall}|${model.status.components.map((c) => `${c.name}:${c.state}`).join(",")}`
  const body = `${model.notices.map(noticeBlock).join("")}
<div id="changed" class="notice changed" role="status" aria-live="polite">${icon("info", "muted")}<div class="row"><p></p><a class="btn btn-outline btn-sm" href="index.html">Reload</a></div></div>
<div class="hero">
${headlineBlock(model, text, overall)}
${affectedBlock(model, root)}
</div>
${open.length ? `<section aria-labelledby="open-h" class="stack"><h2 id="open-h">Open incidents</h2>${open.map((i) => openIncidentCard(model, i, root)).join("")}</section>` : ""}
${live.length ? `<section aria-labelledby="maint-h" class="stack"><h2 id="maint-h">Maintenance in progress</h2>${live.map((m) => maintenanceCard(m, root)).join("")}</section>` : ""}
${
  single
    ? componentRows(model, single, root, "comp-h")
    : `<section aria-labelledby="groups-h">
  <div class="section-head"><h2 id="groups-h">Services</h2><a class="small" href="${root}components.html">All components</a></div>
  <ul class="card-grid" style="margin-top:1.25rem">${model.groups
    .map(
      (g) => `<li><a class="card" href="${root}${pagePaths.group(g.slug)}"><div class="card-body" style="height:100%">
    <h3 class="card-title">${esc(g.name)}${icon("chevron-right", "muted")}</h3>
    <div class="card-foot">${statePill(g.state)}<span class="xs muted">${plural(g.components.length, "component")}</span></div>
  </div></a></li>`,
    )
    .join("")}</ul>
</section>`
}
<section aria-labelledby="recent-h">
  <h2 id="recent-h">Recent incidents</h2>
  <p class="boxed row" style="margin-top:1rem"><span class="state">${icon(week.length ? "clock" : "operational", week.length ? "muted" : "s-operational")}<span>${week.length ? `${plural(week.length, "incident")} in the last 7 days.` : "No incidents in the last 7 days."}</span></span><a href="${root}incidents.html">See previous incidents</a></p>
</section>
<div style="margin-top:1.5rem">${regionsBlock(model)}</div>`
  return {
    html: layout(model, { title: `${model.page.name} status`, description: `${text}. Current status of ${model.page.name}'s services.`, root, path: "index.html", nav: "status", body, watch }),
  }
}

export function groupPage(model: PageModel, g: GroupView): string {
  const root = ""
  const names = new Set(g.components.map((c) => c.name))
  const touches = (i: IncidentView) => i.components.some((c) => names.has(c.name))
  const open = model.incidents.filter((i) => i.open && touches(i))
  const maint = model.maintenance.filter((m) => m.status !== "Completed" && m.note.components.some((c) => names.has(c)))
  const text = situation(g.components, g.state)
  const body = `${crumbs(root, [["Status", "index.html"], [g.name]])}
<p class="small muted" style="font-weight:500;margin-bottom:.5rem">${esc(g.name)}</p>
${headlineBlock(model, text, g.state)}
${open.length ? `<section aria-labelledby="open-h" class="stack"><h2 id="open-h">Open incidents</h2>${open.map((i) => openIncidentCard(model, i, root)).join("")}</section>` : ""}
${maint.length ? `<section aria-labelledby="maint-h" class="stack"><h2 id="maint-h">Maintenance</h2>${maint.map((m) => maintenanceCard(m, root)).join("")}</section>` : ""}
${componentRows(model, g, root, "comp-h")}
<section aria-labelledby="past-h">
  <div class="section-head" style="margin-bottom:0"><h2 id="past-h">Past incidents</h2><span class="small muted">Last 15 days</span></div>
  ${pastList(model, model.incidents.filter((i) => !i.open && touches(i)), root, 15)}
  <p class="small" style="margin-top:1.5rem"><a href="${root}incidents.html">All previous incidents</a></p>
</section>`
  return layout(model, { title: `${g.name}: ${model.page.name} status`, description: `${text}. Status and history of ${g.name}.`, root, path: pagePaths.group(g.slug), nav: null, body })
}

/** Every component of every group on one page: the count under the Status page's headline opens it. */
export function componentsPage(model: PageModel): string {
  const root = ""
  const body = `${crumbs(root, [["Status", "index.html"], ["All components"]])}
<h1>All components</h1>
<p class="meta"><span>Last updated ${time(model.status.writtenAt)}</span></p>
${model.groups
  .map(
    (g) => `<section aria-labelledby="g-${g.slug}">
  <div class="section-head"><h2 id="g-${g.slug}">${model.groups.length > 1 ? `<a href="${root}${pagePaths.group(g.slug)}">${esc(g.name)}</a>` : esc(g.name)}</h2>${statePill(g.state)}</div>
  <div class="rows">${g.components.map((c) => componentRow(model, c, root)).join("")}</div>
</section>`,
  )
  .join("")}`
  return layout(model, { title: `All components: ${model.page.name} status`, description: `Every component of ${model.page.name}, with its state and history.`, root, path: "components.html", nav: null, body })
}

export function maintenancePage(model: PageModel): string {
  const root = ""
  const live = model.maintenance.filter((m) => m.status === "In progress")
  const up = model.maintenance.filter((m) => m.status === "Scheduled")
  const body = `${crumbs(root, [["Status", "index.html"], ["Maintenance"]])}
<h1>Maintenance</h1>
<p class="lead small">Planned work on ${esc(model.page.name)}. Components under maintenance show the Maintenance state while the work runs, and the time doesn't count against availability.</p>
<section aria-labelledby="live-h" class="stack"><h2 id="live-h">In progress</h2>${live.length ? live.map((m) => maintenanceCard(m, root)).join("") : '<p class="boxed small muted">No maintenance is running now.</p>'}</section>
<section aria-labelledby="up-h" class="stack"><h2 id="up-h">Scheduled</h2>${up.length ? up.map((m) => maintenanceCard(m, root)).join("") : '<p class="boxed small muted">No maintenance is scheduled.</p>'}</section>`
  return layout(model, { title: `Maintenance: ${model.page.name} status`, description: `Maintenance in progress and scheduled for ${model.page.name}.`, root, path: "maintenance.html", nav: "maintenance", body })
}

export function incidentsPage(model: PageModel): string {
  const root = ""
  const today = Math.floor(model.now.getTime() / DAY) * DAY
  const months: { key: string; days: { key: string; items: IncidentView[] }[]; quiet: number }[] = []
  for (let k = 0; k < 90; k++) {
    const key = new Date(today - k * DAY).toISOString().slice(0, 10)
    let m = months.find((x) => x.key === key.slice(0, 7))
    if (!m) months.push((m = { key: key.slice(0, 7), days: [], quiet: 0 }))
    const items = model.incidents.filter((i) => i.start.slice(0, 10) === key)
    if (items.length) m.days.push({ key, items })
    else m.quiet++
  }
  const log: { at: string; stage: string; id: string; title: string }[] = []
  for (const i of model.incidents) for (const u of i.updates) log.push({ at: u.at, stage: u.stage, id: i.id, title: i.title })
  for (const m of model.maintenance) for (const u of m.note.updates) log.push({ at: u.at, stage: u.stage, id: m.note.id, title: m.note.title })
  const since = today - 89 * DAY
  const recentLog = log.filter((e) => Date.parse(e.at) >= since).sort((a, b) => b.at.localeCompare(a.at))
  const body = `${crumbs(root, [["Status", "index.html"], ["Previous incidents"]])}
<h1>Previous incidents</h1>
<p class="meta"><span>${monthLabel(new Date(since).toISOString().slice(0, 7))} to ${monthLabel(new Date(today).toISOString().slice(0, 7))}</span><a class="btn btn-ghost btn-sm" href="#event-log">${icon("list")}Go to the event log</a></p>
${months
  .map(
    (m) => `<section class="card month" aria-labelledby="mo-${m.key}">
  <h2 id="mo-${m.key}" class="month-head">${monthLabel(m.key)}</h2>
  ${m.days
    .map(
      (d) => `<section aria-labelledby="day-${d.key}">
    <div class="day-head"><h3 id="day-${d.key}">${dayLabel(d.key)}</h3><span class="small muted">${plural(d.items.length, "incident")}</span></div>
    <div class="entries">${d.items.map((i) => entry(model, i, root)).join("")}</div>
  </section>`,
    )
    .join("")}
  ${m.days.length ? "" : `<p class="month-empty small muted">${icon("operational", "s-operational")}<span>No incidents reported.</span></p>`}
</section>`,
  )
  .join("")}
<section aria-labelledby="event-log" style="margin-top:3.5rem">
  <h2 id="event-log" style="font-size:1.25rem">Event log</h2>
  <p class="small muted" style="margin-top:.25rem">Every update posted in the last 90 days, newest first.</p>
  ${
    recentLog.length
      ? `<div class="table-wrap bordered" style="margin-top:1rem"><table>
    <caption class="sr-only">Event log, newest first</caption>
    <thead><tr><th scope="col">Time</th><th scope="col">Stage</th><th scope="col">Incident or maintenance</th></tr></thead>
    <tbody>${recentLog.map((e) => `<tr><td>${time(e.at)}</td><td>${esc(e.stage)}</td><td><a href="${incidentHref(root, e.id)}">${esc(e.title)}</a></td></tr>`).join("")}</tbody>
  </table></div>`
      : '<p class="boxed small muted" style="margin-top:1rem">No updates were posted in the last 90 days.</p>'
  }
</section>`
  return layout(model, { title: `Previous incidents: ${model.page.name} status`, description: `Incidents and updates for ${model.page.name} in the last 90 days.`, root, path: "incidents.html", nav: "incidents", body })
}

function chip(name: string, state: ComponentState | null): string {
  return `<span class="chip">${state ? stateIcon(state, "icon-sm") : ""}${esc(name)}${state ? `: ${state === "operational" ? "Operational (named for context)" : STATE_WORDS[state]}` : ""}</span>`
}

export function incidentPage(model: PageModel, i: IncidentView): string {
  const root = "../"
  const items = i.noted
    ? i.updates.length
      ? i.updates.map((u) => updateItem(u, 3))
      : [noteItem("No updates have been posted yet.")]
    : [noteItem(`No updates were posted. Belltower detected this outage when more than one region confirmed failing checks${i.open ? ", and will record when they recover" : ", and recorded when they recovered"}.`)]
  const body = `<p><a class="back" href="${root}incidents.html">${icon("arrow-left", "icon-sm")}Previous incidents</a></p>
<article class="card incident" aria-labelledby="incident-title">
  <div class="incident-head stack-sm">
    <p class="row" style="justify-content:flex-start">${stageBadge(i.stage)}<span class="badge badge-muted">Impact: ${IMPACT_WORDS[i.impact]}</span></p>
    <h1 id="incident-title">${esc(i.title)}</h1>
    <p class="meta" style="margin-top:0"><span>Started ${time(i.start)}${age(i.start)}</span><span>${i.open ? esc(duration(i, model.now)) : i.end ? `Lasted ${esc(duration(i, model.now))}` : "Duration not recorded"}</span></p>
    ${i.body ? `<div class="prose">${renderMarkdown(i.body, 2)}</div>` : ""}
  </div>
  <div class="incident-affected"><span class="small muted">Affected services</span>${i.components.map((c) => chip(c.name, c.state)).join("")}</div>
  <section class="incident-updates" aria-labelledby="upd-h"><h2 id="upd-h" class="sr-only">Updates, newest first</h2>${timeline(items)}</section>
</article>`
  return layout(model, {
    title: `${i.title}: ${model.page.name} status`,
    description: `${i.title}, ${i.open ? "ongoing" : "resolved"}. ${plainText(i.body).slice(0, 140)}`,
    root,
    path: pagePaths.incident(i.id),
    nav: null,
    body,
  })
}

export function maintenanceNotePage(model: PageModel, m: MaintenanceView): string {
  const root = "../"
  const n = m.note
  const items = n.updates.length ? [...n.updates].reverse().map((u) => updateItem(u, 3)) : [noteItem("No updates have been posted.", "maintenance")]
  const body = `<p><a class="back" href="${root}maintenance.html">${icon("arrow-left", "icon-sm")}Maintenance</a></p>
<article class="card incident" aria-labelledby="incident-title">
  <div class="incident-head stack-sm">
    <p class="row" style="justify-content:flex-start"><span class="badge">${icon("maintenance", "icon-sm s-maintenance")}${m.status}</span></p>
    <h1 id="incident-title">${esc(n.title)}</h1>
    <p class="meta" style="margin-top:0"><span>From ${time(n.start)}</span><span>Until ${n.end ? time(n.end) : "not set"}</span></p>
    ${n.body ? `<div class="prose">${renderMarkdown(n.body, 2)}</div>` : ""}
  </div>
  <div class="incident-affected"><span class="small muted">Affected services</span>${n.components.map((c) => chip(c, m.status === "In progress" ? "maintenance" : null)).join("")}</div>
  <section class="incident-updates" aria-labelledby="upd-h"><h2 id="upd-h" class="sr-only">Updates, newest first</h2>${timeline(items)}</section>
</article>`
  return layout(model, { title: `${n.title}: ${model.page.name} status`, description: `Maintenance: ${n.title}.`, root, path: pagePaths.incident(n.id), nav: null, body })
}
