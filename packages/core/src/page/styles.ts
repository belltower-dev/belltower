import type { ModeVars, ResolvedTheme } from "./theme.ts"

/*
 * The status page's stylesheet: plain CSS in the shadcn/ui look, reading
 * only shadcn/ui's variables (--background, --card, --muted-foreground,
 * --border, --radius and the rest) plus the six --state-* colors. A
 * deployment's theme sets those variables and nothing else, so it can't
 * break the layout or the contrast the build has checked.
 *
 * Text uses --foreground and --muted-foreground only; control borders and
 * the focus outline use them too, so they pass whenever the text does.
 */

const declarations = (vars: ModeVars) =>
  Object.entries(vars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n")

const quoteFamily = (f: string) => f.split(",").map((s) => s.trim()).filter(Boolean).join(", ")

/** The theme's variables for light, dark, and the viewer's own setting. */
export function themeCss(theme: ResolvedTheme): string {
  const sans = theme.fonts.sans ? `${quoteFamily(theme.fonts.sans)}, ` : ""
  const mono = theme.fonts.mono ? `${quoteFamily(theme.fonts.mono)}, ` : ""
  return `:root {
  color-scheme: light;
  --radius: ${theme.radius};
  --font-sans: ${sans}ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ${mono}ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
${declarations(theme.light)}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${declarations(theme.dark).replace(/^/gm, "  ")}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${declarations(theme.dark)}
}
`
}

export const PAGE_CSS = `*, ::before, ::after { box-sizing: border-box; border: 0 solid var(--border); }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 400 16px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4, p, ul, ol, dl, dd, figure { margin: 0; }
ul, ol { padding: 0; list-style: none; }
img, svg { display: block; }
button, select { font: inherit; color: inherit; }
a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 1rem; top: -4rem; z-index: 10; }
.skip:focus { top: 1rem; }

.wrap { max-width: 48rem; margin: 0 auto; padding: 0 1rem; }
@media (min-width: 640px) { .wrap { padding: 0 1.5rem; } }
/* Wide screens get a wider grid; running text keeps a readable measure. */
@media (min-width: 1024px) { .wrap { max-width: 72rem; } .prose, .updates, .lead { max-width: 48rem; } }

.site-header { border-bottom: 1px solid var(--border); }
.site-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1rem; padding: 1rem 0 0; }
.brand { order: 1; }
.top-actions { order: 2; }
.tabs { order: 3; flex-basis: 100%; }
.brand { display: inline-flex; align-items: center; gap: .5rem; font-size: 1.125rem; font-weight: 600; letter-spacing: -.01em; text-decoration: none; border-radius: calc(var(--radius) - 2px); }
.brand img { height: 1.75rem; width: auto; }
.logo-dark { display: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .logo-dark { display: block; } :root:not([data-theme="light"]) .logo-light.has-dark { display: none; } }
:root[data-theme="dark"] .logo-dark { display: block; }
:root[data-theme="dark"] .logo-light.has-dark { display: none; }
.top-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.tabs { display: flex; gap: .25rem; overflow-x: auto; margin: 0 -.75rem -1px; }
.tabs a { display: inline-flex; align-items: center; gap: .5rem; padding: .625rem .75rem; font-size: .875rem; font-weight: 500; white-space: nowrap; text-decoration: none; color: var(--muted-foreground); border-bottom: 2px solid transparent; }
.tabs a:hover { color: var(--foreground); }
.tabs a[aria-current="page"] { color: var(--foreground); border-bottom-color: var(--foreground); }
/* From tablet width, the navigation sits in the header row as pills. */
@media (min-width: 768px) {
  /* Equal side columns, so the navigation sits in the true middle whatever the name and button widths. */
  .site-top { display: grid; grid-template-columns: 1fr auto 1fr; padding: 1rem 0; }
  .brand { justify-self: start; }
  .tabs { order: 2; flex-basis: auto; margin: 0; }
  .top-actions { order: 3; justify-self: end; }
  .tabs a { padding: .375rem .75rem; border-bottom: 0; border-radius: calc(var(--radius) - 2px); }
  .tabs a .icon { display: none; }
  .tabs a:hover { background: var(--muted); }
  .tabs a[aria-current="page"] { background: var(--foreground); color: var(--background); }
}

main.wrap { padding-top: 2.5rem; padding-bottom: 4rem; }
@media (min-width: 640px) { main.wrap { padding-top: 3.5rem; padding-bottom: 5rem; } }
section { margin-top: 2.5rem; }
h1 { font-size: 1.875rem; line-height: 1.2; font-weight: 600; letter-spacing: -.025em; }
@media (min-width: 640px) { h1 { font-size: 2.25rem; } }
h2 { font-size: 1.125rem; line-height: 1.4; font-weight: 600; letter-spacing: -.01em; }
h3 { font-size: 1rem; line-height: 1.5; font-weight: 600; }
.headline { display: flex; align-items: flex-start; gap: .75rem; }
.headline .icon { width: 2rem; height: 2rem; margin-top: .125rem; }
@media (min-width: 640px) { .headline .icon { width: 2.25rem; height: 2.25rem; } }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; margin-top: .75rem; font-size: .875rem; color: var(--muted-foreground); }
.lead { margin-top: .75rem; color: var(--muted-foreground); }
.muted { color: var(--muted-foreground); }
.small { font-size: .875rem; }
.xs { font-size: .75rem; }
.num { font-variant-numeric: tabular-nums; }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1rem; }
.stack > * + * { margin-top: 1rem; }
.stack-sm > * + * { margin-top: .5rem; }
.section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem 1rem; margin-bottom: 1rem; }

.icon { width: 1rem; height: 1rem; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.icon-sm { width: .875rem; height: .875rem; }
.s-operational { color: var(--state-operational); }
.s-degraded { color: var(--state-degraded); }
.s-partial { color: var(--state-partial); }
.s-major { color: var(--state-major); }
.s-maintenance { color: var(--state-maintenance); }
.s-nodata { color: var(--state-nodata); }

.pill, .badge { display: inline-flex; align-items: center; gap: .375rem; border: 1px solid var(--border); background: var(--background); font-size: .75rem; font-weight: 500; line-height: 1.25rem; white-space: nowrap; color: var(--foreground); }
.pill { border-radius: 9999px; padding: .125rem .625rem; }
.badge { border-radius: calc(var(--radius) - 2px); padding: 0 .5rem; }
a.pill-link { text-decoration: none; }
a.pill-link:hover { background: var(--muted); text-decoration: underline; }
.badge-muted { background: var(--muted); border-color: transparent; }
.state { display: inline-flex; align-items: center; gap: .375rem; font-size: .875rem; font-weight: 500; white-space: nowrap; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: .5rem; height: 2.25rem; padding: 0 1rem; border: 1px solid transparent; border-radius: calc(var(--radius) - 2px); font-size: .875rem; font-weight: 500; line-height: 1; white-space: nowrap; text-decoration: none; cursor: pointer; background: transparent; }
.btn-sm { height: 2rem; padding: 0 .75rem; }
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
.btn-primary:hover { background: color-mix(in oklab, var(--primary) 90%, var(--background)); }
.btn-outline { background: var(--background); border-color: var(--border); box-shadow: 0 1px 2px 0 rgb(0 0 0 / .05); }
.btn-outline:hover, .btn-ghost:hover { background: var(--muted); }

.card { display: block; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); box-shadow: 0 1px 2px 0 rgb(0 0 0 / .05); }
.card-body { display: flex; flex-direction: column; gap: .75rem; padding: 1.25rem 1.5rem; }
a.card { text-decoration: none; height: 100%; }
a.card:hover { background: var(--muted); }
.card-grid { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 640px) { .card-grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 1024px) { .card-grid { grid-template-columns: repeat(3, 1fr); } }
.card-title { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-weight: 600; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; margin-top: auto; padding-top: .25rem; }
.inset { background: var(--muted); border-radius: var(--radius); padding: 1rem; }

/* The Status page's headline: left-aligned on phones, centered with the icon above on wider screens. */
@media (min-width: 768px) {
  .hero { text-align: center; padding: 1.5rem 0 1rem; }
  .hero .headline { flex-direction: column; align-items: center; gap: 1.25rem; }
  .hero .headline .icon { width: 3.5rem; height: 3.5rem; }
  .hero h1 { font-size: 3rem; }
  .hero .meta { justify-content: center; }
  .hero .affected ul { align-items: center; }
}
.affected ul { display: flex; flex-direction: column; gap: .375rem; margin-top: 1rem; }
.affected li { display: flex; align-items: center; gap: .5rem; }
.affected li .icon { width: 1.125rem; height: 1.125rem; }
.quiet > summary { display: inline-flex; align-items: center; gap: .375rem; font-size: .875rem; color: var(--muted-foreground); border-radius: calc(var(--radius) - 2px); }
.quiet > summary:hover { color: var(--foreground); }
.quiet > div { margin-top: .75rem; }
.notice { display: grid; grid-template-columns: auto 1fr; gap: .25rem .75rem; align-items: start; padding: 1rem 1.25rem; border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); background: var(--card); margin-bottom: 2rem; }
.notice .icon { margin-top: .25rem; }

details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
.chev { margin-left: auto; color: var(--muted-foreground); }
@media (prefers-reduced-motion: no-preference) { .chev { transition: transform .2s ease; } }
details[open] > summary .chev { transform: rotate(180deg); }
.disclosure { border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); background: var(--card); }
.disclosure > summary { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; font-size: .875rem; font-weight: 500; border-radius: calc(var(--radius) + 3px); }
.disclosure > div { padding: 0 1rem 1rem; }
.sub { border: 1px solid var(--border); border-radius: var(--radius); }
.sub > summary { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; font-size: .875rem; font-weight: 500; border-radius: calc(var(--radius) - 1px); }
.sub > div { padding: 0 .875rem .875rem; }

.rows { border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); background: var(--card); box-shadow: 0 1px 2px 0 rgb(0 0 0 / .05); }
.rows > * + * { border-top: 1px solid var(--border); }
.rows > details > summary { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem 1rem; padding: 1rem 1.25rem; }
.rows > details > summary .name { font-weight: 500; margin-right: auto; }
.rows > details > div { padding: 0 1.25rem 1.25rem; }
.rows > details:first-child > summary { border-radius: calc(var(--radius) + 3px) calc(var(--radius) + 3px) 0 0; }
.rows > .plain { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .25rem 1rem; padding: 1rem 1.25rem; }

.bars { display: flex; gap: 2px; height: 2.25rem; margin-top: .5rem; }
.bar { flex: 1 1 0; min-width: 0; border-radius: 2px; }
.bar-operational { background: var(--state-operational); }
.bar-degraded { background: var(--state-degraded); }
.bar-partial { background: var(--state-partial); }
.bar-major { background: var(--state-major); }
.bar-maintenance { background: var(--state-maintenance); }
.bar-nodata { border: 1px solid var(--state-nodata); }
@media (max-width: 639px) { .bar.early { display: none; } .wide-only { display: none; } }
@media (min-width: 640px) { .narrow-only { display: none; } }
.bar-scale { display: flex; justify-content: space-between; margin-top: .375rem; font-size: .75rem; color: var(--muted-foreground); }

.table-wrap { max-width: 100%; overflow-x: auto; }
.table-scroll { max-height: 18rem; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
caption { text-align: left; }
th { height: 2.5rem; padding: 0 .5rem; text-align: left; font-weight: 500; white-space: nowrap; }
td { padding: .5rem; vertical-align: top; }
thead tr, tbody tr { border-bottom: 1px solid var(--border); }
tbody tr:last-child { border-bottom: 0; }
th.num, td.num { text-align: right; }
.bordered { border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); }

dl.facts { display: grid; grid-template-columns: 1fr; gap: .25rem 1.5rem; font-size: .875rem; }
@media (min-width: 640px) { dl.facts { grid-template-columns: auto 1fr; } }
dl.facts dt { color: var(--muted-foreground); }
dl.facts dd + dt { margin-top: .5rem; }
@media (min-width: 640px) { dl.facts dd + dt { margin-top: 0; } }
.boxed { padding: 1.25rem; border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); }

.stats { display: grid; grid-template-columns: 1fr; border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); }
.stats > div { padding: 1rem 1.25rem; }
.stats > div + div { border-top: 1px solid var(--border); }
@media (min-width: 640px) { .stats { grid-template-columns: repeat(3, 1fr); } .stats > div + div { border-top: 0; border-left: 1px solid var(--border); } }
.stat-value { font-size: 1.5rem; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
progress { appearance: none; display: block; width: 100%; height: .5rem; margin-top: .375rem; border: 0; border-radius: 9999px; background: var(--muted); overflow: hidden; }
progress::-webkit-progress-bar { background: var(--muted); }
progress::-webkit-progress-value { background: var(--foreground); }
progress::-moz-progress-bar { background: var(--foreground); }

.chart { display: flex; align-items: flex-end; gap: 2px; height: 4rem; margin-top: .5rem; }
.chart span { flex: 1 1 0; min-height: 1px; border-radius: 2px 2px 0 0; background: color-mix(in oklab, var(--muted-foreground) 45%, transparent); }
.chart span.empty { background: transparent; }

.past > li { display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; align-items: start; padding: 1rem 1.25rem; }
.past > li > time { grid-column: 1 / -1; }
@media (min-width: 640px) { .past > li { grid-template-columns: 7.5rem 1fr auto; } .past > li > time { grid-column: auto; padding-top: .125rem; } }
.back { display: inline-flex; align-items: center; gap: .5rem; font-size: .875rem; color: var(--muted-foreground); text-decoration: none; margin-bottom: 1.25rem; }
.back:hover { color: var(--foreground); text-decoration: underline; }
.incident { overflow: hidden; }
.incident-head { padding: 1.5rem; }
@media (min-width: 640px) { .incident-head { padding: 2rem; } }
.incident-affected { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: 1rem 1.5rem; border-top: 1px solid var(--border); }
@media (min-width: 640px) { .incident-affected { padding: 1rem 2rem; } }
.chip { display: inline-flex; align-items: center; gap: .375rem; padding: .25rem .75rem; border-radius: 9999px; background: var(--muted); font-size: .875rem; }
.incident-updates { margin: 0; padding: 1.5rem; background: var(--muted); border-top: 1px solid var(--border); }
@media (min-width: 640px) { .incident-updates { padding: 2rem; } }
.timeline > li { position: relative; display: grid; grid-template-columns: 1.25rem 1fr; gap: .75rem; padding-bottom: 1rem; }
.timeline > li:last-child { padding-bottom: 0; }
.timeline > li:not(:last-child)::before { content: ""; position: absolute; left: .625rem; top: 2.25rem; bottom: .25rem; width: 1px; background: var(--border); }
.tl-icon { padding-top: 1rem; }
.tl-icon .icon { width: 1.25rem; height: 1.25rem; }
.tl-card { min-width: 0; padding: 1rem 1.25rem; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 1px 2px 0 rgb(0 0 0 / .04); }
.month { margin-top: 2rem; overflow: hidden; }
.month section { margin-top: 0; }
.month-head { padding: 1.25rem 1.5rem; font-size: 1rem; font-weight: 600; }
.month .day-head { border-radius: 0; padding: .75rem 1.5rem; }
.month .day-head h3 { font-size: .875rem; font-weight: 500; }
.month .entries > article { padding: 1.25rem 1.5rem; }
.month-empty { display: flex; align-items: center; gap: .5rem; padding: 0 1.5rem 1.25rem; }
.earlier > summary { display: inline-flex; align-items: center; gap: .75rem; font-size: .875rem; color: var(--muted-foreground); border-radius: calc(var(--radius) - 2px); }
.earlier > summary:hover { color: var(--foreground); }
.earlier > summary .icon:first-child { width: 1.25rem; height: 1.25rem; }
.earlier > .timeline { margin-top: .75rem; }
.day-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .625rem 1rem; border-radius: var(--radius); background: var(--muted); }
.entries > article { padding: 1.25rem 0; }
.entries > article + article { border-top: 1px solid var(--border); }
.updates { border-left: 1px solid var(--border); }
.updates > li { position: relative; padding: 0 0 1.25rem 1.25rem; }
.updates > li:last-child { padding-bottom: 0; }
.updates > li::before { content: ""; position: absolute; left: -.3125rem; top: .5rem; width: .5625rem; height: .5625rem; border-radius: 9999px; background: var(--background); border: 2px solid var(--foreground); }
.prose { line-height: 1.6; }
.prose > * + * { margin-top: .75rem; }
.prose ul { list-style: disc; padding-left: 1.25rem; }
.prose ol { list-style: decimal; padding-left: 1.25rem; }
.prose code { font-family: var(--font-mono); font-size: .875em; background: var(--muted); padding: .1em .3em; border-radius: calc(var(--radius) - 4px); }

.breadcrumbs ol { display: flex; flex-wrap: wrap; gap: .375rem; font-size: .875rem; color: var(--muted-foreground); margin-bottom: 1.5rem; }
.breadcrumbs li + li::before { content: "/"; margin-right: .375rem; }

.site-footer { border-top: 1px solid var(--border); }
.footer-inner { display: flex; flex-direction: column; gap: 1.5rem; padding-top: 2rem; padding-bottom: 2rem; font-size: .875rem; }
@media (min-width: 640px) { .footer-inner { flex-direction: row; align-items: flex-end; justify-content: space-between; } }
.footer-links { display: flex; flex-wrap: wrap; gap: .25rem 1rem; }
.mode { display: flex; align-items: center; gap: .5rem; }
.mode label { font-weight: 500; }
select { height: 2rem; padding: 0 2rem 0 .75rem; border: 1px solid var(--muted-foreground); border-radius: calc(var(--radius) - 2px); background: var(--background) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right .5rem center / 1rem; appearance: none; cursor: pointer; }
[popover]:not(:popover-open) { display: none; }
[popover] { margin: auto; width: min(22rem, calc(100vw - 2rem)); padding: 0; inset: 0; height: fit-content; }
[popover]::backdrop { background: rgb(0 0 0 / .25); }
.changed { display: none; }
.changed.show { display: grid; }
`
