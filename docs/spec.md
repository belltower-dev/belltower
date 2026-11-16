# Belltower: specification

Belltower is an open-source uptime monitor and status page that runs on any serverless
platform: AWS, Cloudflare, Google Cloud, Kubernetes (Knative or CronJobs) or
any host that runs a container. It checks real behavior rather than only
pinging URLs, decides an outage only when several regions agree, and
publishes a status page and the monthly availability figure an SLA is
measured against.

Companion documents:

- [certificates.md](certificates.md): certificate and domain expiry checks on
  every platform.
- [plan.md](plan.md): the build order.

The feature set covers what a small team needs from an uptime service:
monitor settings, heartbeats, incidents, status pages and reporting.

## What it must do

1. Report an outage within about two minutes, without alerting on one
   region's network blip.
2. Notice what a URL check can't: a scheduled job that stopped, email that
   never arrives, a page that shows content it should hide.
3. Publish current status, history and incidents by component on a page that
   stays up when the watched service is down.
4. Produce monthly availability per component, with announced maintenance
   excluded, so an SLA and its credits can be computed from it.
5. Meet WCAG 2.1 AA in everything people see or read.
6. Run unchanged on any supported platform. Moving platforms means changing
   the adapter and the deploy template, not the checks.

## What it won't do

- On-call rotations and calendars, teams, routing rules. Alerts escalate
  down one short list of contacts at most.
- Phone call alerts. Email, SMS and webhooks.
- Logs, traces, metrics, error tracking, session replay. Use an APM tool.
- AI incident investigation, a post-mortem tool. Post-mortems are Markdown in
  the deployment's repository.
- Ping, TCP, UDP, SMTP, POP, IMAP and DNS monitor types in the first version.
- Status page subscriptions by SMS, unless deployments ask. Feeds come
  first, then email and webhooks, then Slack.

## Architecture

### The core

- TypeScript, ES modules, web-standard APIs only: `fetch`, `Request` and
  `Response`, Web Crypto, `URL`. No Node built-ins and no cloud SDKs.
- Pure where it can be: the confirmation and recovery rules, heartbeat
  timing, incidents, maintenance and availability math take data in and
  return data, with time passed in. Tested without any platform.
- Everything specific to a deployment is configuration: checks, components,
  regions, thresholds, notifiers, maintenance. Nothing about any one service
  is in the code.

### What the platform calls

| Entry point | When | Does |
| --- | --- | --- |
| `runChecks(region)` | Every minute, in each region | Runs the checks assigned to that region, writes one results file |
| `decide()` | Every minute, in one place | Applies the rules, opens and closes incidents, sends alerts, writes status |
| `handle(request)` | On HTTP requests | Heartbeat pings, acknowledge links. A standard fetch handler |
| `buildPage()` | Every 10 minutes, or in CI | Writes the static status page |

### What the platform supplies

| Port | Required | Methods | Examples |
| --- | --- | --- | --- |
| Store | Yes | `get`, `put`, `list(prefix)` | S3, R2, Google Cloud Storage, MinIO, a local folder for tests |
| Notifier | At least one | `send(alert)` | SES, Cloudflare Email Service, SMTP, Resend, SNS, Twilio, a webhook (Slack, Teams) |
| Secrets | Yes | `get(name)` | Environment variables by default; AWS SSM, Google Secret Manager |
| Inbox | No | `find(runId)` | SES inbound to S3, Cloudflare Email Routing to R2. Without one, the email round trip is off |
| TLS inspector | No | `inspect(host, port, servername)` | `node:tls` on Node runtimes. See [certificates.md](certificates.md) |
| HTTP client | No | `fetch(request, { verifyTls })` | Web-standard `fetch` by default. An adapter's own client can skip certificate verification and report DNS, connect and TLS times |

The store must give read-after-write consistency and be reachable from every
region. S3, R2 and Google Cloud Storage all do. Every Store passes the same
contract suite (`@belltower/core/contracts`):

- `get` returns `null` for a key never written, and an empty body as `""`.
- `put` replaces a key's contents, and a `get` right after sees the new
  contents, including after many parallel puts.
- `list(prefix)` returns every key that starts with the prefix, at any
  depth, in lexical order. The prefix can end partway through a name
  (`results/us` also matches `results/use/...`).

The core includes an in-memory Store for tests, and `s3Store` for any
S3-compatible storage (AWS S3, Cloudflare R2, Google Cloud Storage's XML
API, MinIO). It speaks the S3 API over `fetch`, signing requests with AWS
Signature Version 4 through Web Crypto, so every adapter can use it with no
SDK. It can keep a deployment's keys under a prefix, so one bucket can hold
several deployments, and uses the bucket's own host name on amazonaws.com
and the path elsewhere. The container adapter includes a local-folder Store: one file per key, written to a temporary
file and renamed into place, refusing keys with empty, `.` or `..` parts.

### Adapters

| Adapter | Runs on | Schedules with | Store, email, TLS |
| --- | --- | --- | --- |
| `aws` | Lambda (Node) | EventBridge Scheduler | S3, SES and SNS, TLS inspector |
| `cloudflare` | Workers | Cron Triggers | R2, Email Service and Email Routing; TLS inspector only if the startup probe passes ([certificates.md](certificates.md)) |
| `container` | A Node server image with a `run` command | Cloud Scheduler with Cloud Run, Knative `PingSource`, Kubernetes `CronJob`, Fly, Railway | Any S3-compatible store or Cloud Storage; SMTP, Resend, webhooks; TLS inspector |

The container adapter covers Google Cloud, Kubernetes and most other hosts,
so three adapters reach nearly everything.

#### The aws adapter

Three Lambda handlers, made by `createHandlers(config)` in the
deployment's own handler file, so the config is bundled into the function
and validated once per cold start:

- `checks`: scheduled every minute in every region; runs `runChecks` for
  the function's region.
- `decide`: scheduled every minute in one region.
- `http`: behind a function URL; serves `handle()`.

It calls S3, SSM, SES and SNS over `fetch` with the core's SigV4 signer, so
the function carries no AWS SDK. Settings are environment variables:
`BELLTOWER_REGIONS` (every region in the deployment), `BELLTOWER_REGION`
(this one; default `AWS_REGION`), `BELLTOWER_BUCKET`,
`BELLTOWER_BUCKET_REGION`, `BELLTOWER_BUCKET_PREFIX`,
`BELLTOWER_SSM_PREFIX` and `BELLTOWER_EMAIL_FROM`. A missing setting or an
invalid config fails the cold start with every problem listed in the log.

Secrets are read from environment variables first, then from SSM
Parameter Store under `BELLTOWER_SSM_PREFIX` (decrypted, cached five
minutes). Email goes through SES v2 as plain text from a verified sender;
SMS goes through SNS as transactional messages carrying the title and the
first line of the alert. Each run logs one JSON line.

### Capabilities

Each adapter declares what it supports (`tlsInspector`, `inbox`, `sms`,
`skipTlsVerify`, `timingBreakdown`). At deploy, the config is checked
against the regions it runs in:

- A check is assigned only to regions whose adapter supports it. A daily
  certificate check can run from one Node region while HTTP checks run from
  Workers regions. An HTTP check with `verifyTls: false` runs only in
  regions that declare `skipTlsVerify`, since web-standard `fetch` always
  verifies.
- A check no region can run fails the deploy with the reason and the options
  ([certificates.md](certificates.md) lists them for certificate checks).

### Rules for whoever runs it

- Run it on different infrastructure from what it watches. A monitor on the
  same platform goes down in the outage it should report.
- One `decide()` per deployment. Regions are separate schedules (or clusters)
  writing to the same store.
- Put the status page on a host and, ideally, DNS separate from the watched
  service.

## Checks

A deployment's config lists checks:

| Field | Meaning | Default |
| --- | --- | --- |
| `id` | Stable name, used in results and alerts | |
| `component` | Which status page component it counts toward | |
| `type` | `http`, `heartbeat`, `email`, `tls`, `domain` | |
| `url`, `method`, `headers`, `body` | The request (`http`) | `GET` |
| `basicAuth` | Secret name holding `user:password` | none |
| `expectStatus` | Status codes that pass | any 2xx |
| `expectKeyword` | Text the body must contain | none |
| `rejectKeyword` | Text the body must not contain | none |
| `timeoutSeconds` | Request timeout | 10 |
| `slowSeconds` | Slower than this counts as Degraded, not Down | 5 |
| `followRedirects`, `verifyTls` | | `true`, `true` |
| `regions` | Which regions run it | all |
| `priority` | `P1` (most urgent) to `P5`; picks which notifiers send its alerts (see "Incidents and alerts"). Written `"P1"` or `1` | its component's, else `P3` |
| `incidentKey` | Checks with the same key share one incident, such as `database` for every check that fails when the database does | the check id |
| `public` | Whether it shows on the status page | `true` |

Checks send the user agent `Belltower/<version>` so the watched service
can leave them out of its analytics and rate limits. A `User-Agent` in
`headers` replaces it.

`expectStatus` takes codes and classes: `204`, `"2xx"`, or a list such as
`["2xx", 304]`. Durations (`period`, `grace`, `within`, `schedule`) are
written as `"30s"`, `"15m"`, `"1h"`, `"1d"`, `"daily"` or `"hourly"`, or as a
whole number of seconds.

### The rest of the config

Besides `checks`, a config has:

| Section | Fields | Default |
| --- | --- | --- |
| `components` | `name`; `priority` (for its checks that don't set one); `target` (monthly availability percentage, such as 99.9); `credits` (tiers such as `[{ "below": 99.9, "percent": 10 }, { "below": 99, "percent": 25 }]`); `group` (the heading it's listed under on the page, such as "Europe" or "Storage"); `description` (one line); `link` (the thing itself, such as the web app's address) | `P3`, no target, no credits, no group |
| `page` | The status page and its branding (see "Status page") | |
| `notifiers` | `id`; `type` (`email`, `sms`, `webhook`); `to` (email addresses, or phone numbers in international format such as `+15555550100`); `secret` (webhook only: the name of the secret holding the URL); `upTo` (the lowest priority it sends, `P1` to `P4`: `P2` sends P1 and P2) | `upTo`: `P4`, or `P2` for SMS |
| `thresholds` | `confirmRegions`, `confirmMinutes`, `degradedMinutes`, `recoverRegions`, `recoverMinutes`, `repeatAlertMinutes` | 2, 2, 5, 2, 3, 30 (see "Deciding that something is down") |

The adapter supplies the regions and what each can do; the config names
regions only to limit a check to some of them.

### Validation

`validateConfig(config, regions)` runs at deploy and refuses a config with
any of these, listing every error at once with the field it's about. Each
issue has a stable `code` (`required`, `invalid`, `empty`, `unknown-field`,
`duplicate`, `unknown-reference`, `conflict`, `missing-capability`,
`no-regions`), a `path` as a JSON pointer (`/checks/0/timeoutSeconds`), a
`message`, and a `fix` when the message doesn't already say what to do.
The same issues also come as one readable line each.

- A missing required field, a value of the wrong kind, or a field the check
  type doesn't have. A likely typo gets a suggestion (`expectKeywords`:
  "Did you mean expectKeyword?").
- A check, component or notifier `id` used twice, or an `id` that isn't
  lowercase letters, digits, `-` and `_` (ids appear in storage keys).
- A check whose `component` isn't in `components`.
- `slowSeconds` at or above `timeoutSeconds`, `alertDays` above `warnDays`,
  a body on a `GET` or `HEAD`, or a keyword on a `HEAD`.
- An `sms` notifier when no region's adapter can send SMS.
- A priority outside `P1` to `P5`, a notifier `upTo` of `P5`, or an
  `incidentKey` that isn't an id.
- `severity`, a component's `critical` or a notifier's `levels`, from
  earlier drafts: the error names the field that replaced it.
- A check no region can run ("Capabilities").

### HTTP

- **Fails when** the request errors, times out, returns a status outside
  `expectStatus`, misses `expectKeyword` or contains `rejectKeyword`. When
  several apply, `rejectKeyword` is the one reported, since it means
  private content is showing.
- `rejectKeyword` is how a deployment checks that protected content stays
  protected: request a private page signed out and reject a phrase from its
  body. Give such checks priority `P1`, since a failure is a data exposure, not
  an outage.
- **Each result records** whether it passed, whether it was slow, and its
  timing in milliseconds: time to first byte (from the start of the request
  to the response headers), download and total. Regions whose adapter
  declares `timingBreakdown` also record DNS lookup, connect and TLS
  handshake, so a slow check comes with a reason.
- **A failed result also records** why, as a code (`network`, `timeout`,
  `status`, `missing-keyword`, `rejected-keyword`, `secret`, `unsupported`)
  and a sentence, plus the status, response headers and the first 2 KB of
  the body for the incident.
- The timeout covers the whole response, body included.

### Heartbeats

For scheduled jobs: a URL check can't see a job that stopped.

| Field | Meaning |
| --- | --- |
| `period` | How often a success is expected. Required |
| `grace` | Extra time before a missing success counts as down. Default 5 minutes |
| `token` | Name of the secret holding the secret part of the ping URL |

- The job calls `GET {handle}/hb/{token}` when it succeeds and
  `/hb/{token}/fail` when it fails. `HEAD` and `POST` work too, and the path
  can sit under any prefix (`/belltower/hb/{token}`). A success can carry
  `?run={id}` for the email round trip.
- `handle()` answers `200` with a line of plain text naming the check, `404`
  for a token no heartbeat has, and `405` for other methods. It never echoes
  the token, and compares tokens in time that doesn't reveal a near match.
- Each ping updates `heartbeats/{id}.json`: the last success, the last
  failure and the last run ID.
- Down when no success arrives within period plus grace (the incident starts
  at the moment it was due), or a `/fail` newer than the last success
  arrives. Up again on the next success, with no waiting period.
- `decide()` judges heartbeats every minute, so a miss alerts within a
  minute of period plus grace, and a `/fail` on the next run.
- A heartbeat that has never pinged is `pending`: no alert, and Operational
  on the status page.
- States: `pending` (no ping yet), `up`, `down`, `maintenance`, `paused`.
- A failed ping must never fail the job that sends it.

### Email round trip

For services that send email: a delivery problem never shows on a web check.

- The watched service sends a message to an address the inbox port can read,
  with a run ID, on a schedule.
- The service also sends its heartbeat with the same run ID.
- Down when the message hasn't arrived a set time (`within`, default 30
  minutes) after that heartbeat. The check's `heartbeat` field names that
  heartbeat check.
- Needs the Inbox port; off without one.

### Certificates and domains

Certificate expiry, chain and hostname checks, and domain registration
expiry by RDAP. Daily, from one region. Full design, defaults and per-platform
instructions: [certificates.md](certificates.md).

## Deciding that something is down

- **Frequency:** every 60 seconds from each region.
- **Confirmed down when** at least two regions fail the same check in two
  consecutive minutes. One region failing alone is recorded, not alerted.
  With a single region, two consecutive failures.
- **Degraded when** at least two regions pass but slower than `slowSeconds`
  for five consecutive minutes. Shown on the page; not downtime.
- **Recovered when** the check passes in at least two regions for three
  consecutive minutes.
- All counts are configuration; these are the defaults.
- **Consecutive minutes** means each of those minutes, on its own, has
  enough regions failing (or passing); they needn't be the same regions.
  When fewer regions run a check than a count asks for, every region that
  runs it must agree.
- **Silence confirms nothing.** A minute with no result for a check breaks
  every streak for it.
- **`decide()` judges the last complete minute.** Regions run at the top of
  the minute, so the current minute's results may not all be written; they
  count on the next run.

## Incidents and alerts

- **One incident per problem.** A check confirmed down opens an incident
  starting at its first failing minute, or joins the open incident for its
  `incidentKey`. The id is the key (the check id when there's no key) and
  the first failing minute in UTC (`home-202611151001`,
  `database-202611151001`).
- **Each incident keeps** its key, priority, components, start and end, and
  for each of its checks: the component, when it was down (a check that
  recovers and fails again while the incident is open gets another span),
  a summary, the regions, and from the first failure in each region the
  status code, timing, response headers and the first 2 KB of the body.
- **Priority** is the most urgent of its checks' priorities. A check's
  priority is its own, else its component's, else `P3`.
- **Alerts:**
  - On open and on resolution, to every notifier whose `upTo` covers the
    incident's priority. By default email and webhook notifiers send P1 to
    P4 and SMS sends P1 and P2. P5 incidents are recorded and never sent.
  - A check that joins an open incident sends an alert only when its
    priority is more urgent than the incident's, which then takes it.
    Otherwise it's recorded without an alert, so a database outage that
    breaks five checks pages once.
  - Titles start with the priority and name the checks and components:
    `P1 down: orders, search (API)`, `P1 recovered: ...`.
  - The open alert repeats every 30 minutes until acknowledged, by a signed
    link in the alert.
- **Resolved automatically** when every check in it has recovered; the
  recovery alert gives the duration, which ends at the first minute of the
  last check's passing streak.
- **Availability** counts each public check's own spans, so a component is
  down only while one of its own public checks was, even when the incident
  ran longer for another component.
- **Alerts go out at least once.** `decide()` writes the incident, sends
  the alert, then records that it did. If it stops in between, the next run
  sends the alert again rather than never. A notifier that fails doesn't
  stop the others; the failure is in `decide()`'s report.
- **Webhook notifiers** POST JSON to the URL in their secret:
  `{ "format": "belltower.alert/1", "priority", "title", "text", "url" }`.
  Fields are only added within a format version. The core sends webhooks
  itself; adapters supply email and SMS, and a notifier type the adapter
  can't send stops it at startup with the notifier's id.
- **Public incident notes** are Markdown files in the deployment's
  repository, written by hand: title, component, start, end, updates with
  times. A detected incident shows as "Detected outage" until a note names
  it in `detected`. The format is in "Notes", below.
- **Who watches Belltower:** `public/status.json` carries the time it was
  written. The deployment should have something outside Belltower (the
  watched service itself, or a free external check) alert when it's more
  than 10 minutes old.

## Maintenance

- Declared by a Markdown note with components, start and end.
- During the window, checks still run, but `decide()` opens no incident and
  sends no alert for those components, and the minutes count neither up
  nor down. The component's state is Maintenance, unless an incident was
  already open when the window began.
- An outage that outlasts the window counts from the window's end.
- Shown on the status page from the moment the note is published.

## Notes

Incident and maintenance notes are Markdown files in a folder of the
deployment's repository. Each starts with a header between `---` lines:

```
---
type: maintenance
title: Database upgrade
components: API, Website
start: 2026-11-20T02:00:00Z
end: 2026-11-20T03:00:00Z
---
We're moving the API's database to a larger server.

## 2026-11-20 02:40 UTC
The copy is done; switching over now.
```

- `type` is `maintenance`, `incident` or `notice`. `component` works for
  one.
- A notice is a standing message, such as a planned change, shown at the
  top of the Status page while it's current. It has no effect on states,
  alerts or availability. Its components are optional, and so are its
  times: without `start` it shows from publication, without `end` until
  it's removed.
- Times are ISO times with a zone. `end` is required for maintenance and
  optional for an incident still open.
- `detected` (incidents only) lists the detected incident ids the note
  explains, separated by commas.
- `impact` (incidents only) is `none`, `minor`, `major` or `critical`;
  default `minor`.
- Each level-two heading `## yyyy-mm-dd hh:mm UTC` starts an update, with
  an optional stage after the time: `## 2026-11-20 02:40 UTC Identified`.
  Stages are Investigating, Identified, Monitoring, Resolved and Update;
  without one, an update is an Update. The text before the first update
  is the summary.
- An update's first line can name components and their states:
  `Components: API (Degraded performance), Website (Operational)`. The
  states are the five component states; the components must be in the
  config.
- The note's id is its file name without `.md`.

`belltower notes push --dir <folder>` checks every note against the config
and publishes them to `public/notes.json`. One error in any note
publishes nothing, with exit code 3, the file, the field and a fix. It
also warns, without failing, about images without alt text, links whose
text is only "here" or a bare URL, skipped heading levels, and HTML tables
without header cells. `decide()` reads `public/notes.json` every minute.

## Status page

Built as static HTML by `buildPage()` from the `public/` files alone,
never the config, and deployable to any static host (GitHub Pages, S3, R2,
Cloud Storage, Netlify). Without JavaScript every page shows the state as
of the last build; with it, the status page refreshes from
`public/status.json`. WCAG 2.1 AA throughout ("Accessibility", below).

### Pages

The first view is short: a visitor picks what they use, and details come
after a click. No bars appear until a group is opened.

| Page | Shows |
| --- | --- |
| Status | The overall state as a headline with its state icon ("All services are online", or the situation in a sentence) and "Last updated"; a pill counting components that are operational ("13 of 13 components operational"); a "Checked from" control; current notices, open incidents and maintenance in progress; then a card per component group with its description and its state in words; then one line of recent incidents with a link to Previous incidents |
| One per group | The group's state, then its components as a bordered list, each with its state in words. A component row expands to its description, 90-day bars, response time, and this month's availability against the target with the downtime budget. Then a legend, and the group's incidents for the last 15 days, by day |
| Maintenance | Maintenance in progress and upcoming |
| Previous incidents | The last 90 days, newest first, under a heading for each month; each day with incidents has a row with its date and count; each incident shows its stage, its latest update with stage and time, and "N previous updates" folded beneath. A month with nothing says so. Then an event log: every update of every incident and maintenance in one list, newest first, with a link at the top of the page that goes straight to it |
| One per incident | A permanent address: title, stage, impact, duration, components affected, and every update with its stage and time |

Plus `feed.atom`, `feed.rss` and `feed.json` (JSON Feed) of incidents and
maintenance, `summary.json`, and a Markdown copy of each page (see
"Machine-readable status").

### States

Each component has one of five states, always in words, never color alone,
with a legend that lists them:

| State | When |
| --- | --- |
| Operational | Nothing below applies |
| Degraded performance | A public check in the component is degraded |
| Partial outage | Some of the component's public checks are down |
| Major outage | All of the component's public checks are down |
| Maintenance | A maintenance note covers the component now, and no incident was open when it began |

A check counts as down only when it's confirmed ("Deciding that something
is down"), so one region failing alone changes nothing. The overall state
is the worst component state, ordered Major outage, Partial outage,
Degraded performance, Maintenance, Operational.

### Components

- Grouped by `group`, in config order. Each group is a card on the Status
  page and has its own page. Components without a group share one.
- On its group's page, each component is a row with its name (a link when
  `link` is set) and its state. The row is a button with `aria-expanded`
  that opens its `description`, its 90-day bars and the rest below.
- **90-day bars,** one per day. Days before monitoring began show as "No
  data", and the legend includes it. Each bar has a text label (date, uptime
  percentage, time degraded, incidents), such as "14 November: 99.9% up, 6
  hours degraded, 1 incident", and the same figures are in a table. A day
  that was degraded but never down shows as degraded, in words as well as
  color. Under the bars, this month's availability next to the target.
- **Response time:** a chart of the last 24 hours and the last 90 days,
  with the same figures in a table. `decide()` keeps the figures as it
  goes: hourly and daily medians of the passing public HTTP checks'
  total times, and the minutes each day a component was degraded. Degraded
  minutes don't count against availability. The medians come from
  histograms with 2% buckets, so they're within 1% of the exact value and
  `state/metrics.json` stays small. `public/history.json` carries them:
  each day's `degradedMinutes` and `responseMs`, and each component's last
  24 whole `hours`.
- Heartbeat, certificate and domain checks are usually internal
  (`public: false`) and don't appear.

### Incidents

- Open incidents first, then the last 90 days. With none open, the Status
  page says "No incidents in the last 7 days" when that's true, with a link
  to Previous incidents.
- **Stage:** each update has one, as a word: Investigating, Identified,
  Monitoring, Resolved, or Update.
- **Impact:** None, Minor, Major or Critical. "None" is for components
  named for context only.
- **Updates** newest first, each with its stage and time.
- **Duration** from start to end, or "Ongoing".
- **Age:** with JavaScript, each incident's date is followed by its age
  ("9 days ago"), worked out in the browser so it's never stale. Without
  JavaScript the date stands alone.
- **Component states per update:** an update can name the components it
  affects and their state at that time, such as "API: Degraded
  performance", so the page shows how an incident moved.
- A detected incident with no note shows as "Detected outage", with the
  checks' components and the time it began.

### Checked from

A section on the Status page lists the regions checks run from, each with
whether it's writing results: "Writing results" when its last results
file is under five minutes old, otherwise "No results since {time}".
Visitors see where checks run, and a stalled region is visible to
everyone, the deployment included. `decide()` records each region's last
results time in `public/status.json`.

### Times

Every time is shown in the viewer's time zone with UTC alongside, such as
"14:40 (13:40 UTC)". Without JavaScript, times show in UTC.

### Light and dark

System, light and dark, following the viewer's setting unless they choose
one; the page's `mode` sets the default. The choice is a native control
and is remembered on that device.

### Branding

A deployment makes the page its own with a theme, its logo, and the
colors of its states. The theme uses the shadcn/ui theme format, so a
theme from a deployment's own shadcn/ui app, or one made in a theme editor
such as tweakcn, works as it is.

From the config's `page` section:

| Field | Meaning | Default |
| --- | --- | --- |
| `name`, `link` | The deployment's name and home page. With `link`, the header also shows a visible "Go to {name}" link. `name` is required when `page` is set | `Status` |
| `logo`, `logoDark` | `{ "src", "alt" }`: an image address (SVG preferred) and its required alt text | the name in text |
| `favicon` | Image address | none |
| `theme` | A theme in the shadcn/ui registry format: a file path, a URL fetched at build, or the same object inline. Its light and dark variables (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-1` to `chart-5`, `radius`) and fonts (`font-sans`, `font-mono`, `font-serif`) style the page | Belltower's neutral theme |
| `states` | Colors for the six day and state marks (`operational`, `degraded`, `partial`, `major`, `maintenance`, `nodata`), each with a light and a dark value, for a deployment that already has its own status colors | taken from the theme's chart and destructive colors |
| `mode` | `system`, `light` or `dark` | `system` |
| `footer` | `{ "text", "links": [{ "text", "url" }] }` | none |
| `poweredBy` | Show "Powered by Belltower" | `true` |
| `reportProblem` | An http, https or mailto address for a "Report a problem" link | none |

- **How the theme maps:** the page's surfaces come from `background`,
  `muted` and `border`; text from `foreground`; buttons and links from
  `primary`; outages from `destructive`; corners from `radius`; focus from
  `ring`. Fonts named by the theme are fetched once at build and served
  from the page's own host, so visitors make no third-party requests.
- **Contrast is checked when the page is built,** in both modes: text and
  state words 4.5:1 on every surface they sit on, bars, icons, borders of
  controls and the focus indicator 3:1, and the primary button's text on
  its fill. A failing pair stops the build with the two colors, the ratio,
  and the nearest value that passes.
- **No custom CSS or scripts.** A theme is variables, which the build can
  check; rules and scripts are where branding breaks accessibility.
- The page is served from the deployment's own domain; the docs show the
  DNS record for each static host.

### Machine-readable status

- `summary.json` follows the shape widely used by status page widgets and
  aggregators: the page, an overall status indicator and description,
  components with their states, open incidents, and scheduled maintenance.
  Existing tools read a Belltower page without changes. The indicator is
  `none`, `minor`, `major`, `critical` or `maintenance` for Operational,
  Degraded performance, Partial outage, Major outage and Maintenance;
  component statuses are `operational`, `degraded_performance`,
  `partial_outage`, `major_outage` and `under_maintenance`; each group is
  also listed as a component with `group: true`. A detected incident no
  note explains is listed as "Detected outage".
- **Feeds** have one entry per incident and maintenance note (notices are
  left out), newest change first, with the stage, the components, the
  summary and every update in plain text. Upcoming maintenance is dated
  from when it was published.
- The builder is given the address the page is served from, for the
  absolute links feeds and `summary.json` need. An incident's page is
  `incidents/{id}.html`, a group's is `{group}.html`, where `{group}` is
  its name in lowercase letters, digits and `-`.
- `status.json`, `history.json` and the feeds sit beside it. All are
  readable from other sites (CORS allowed) and cached briefly.
- **Markdown copies.** Each page has a copy at the same address with `.md`
  added (`index.md`, `incidents.md`, `{group}.md`, `incidents/{id}.md`),
  linked from the page with `<link rel="alternate" type="text/markdown">`.
  The bars become a line of symbols with a legend in words (`+` Operational, `~` Degraded,
  `x` Outage, `=` Maintenance, `.` No data). Agents and scripts read them
  without parsing HTML, and static hosts serve them as plain files.
- `llms.txt` lists the pages, their Markdown copies, the JSON files and the
  feeds, each with one line on what it holds.

## Accessibility

Belltower must conform to WCAG 2.1 Level AA. This is a release requirement,
not a goal: a version that fails it doesn't ship.

### What it covers

Everything Belltower produces for people:

- The status page, including its history, incidents, maintenance and any
  state that changes while the page is open.
- Alert emails: semantic HTML with a plain-text part that says the same.
- Pages served by `handle()`: the acknowledge page and error responses.
- The README and the docs site.
- Any configuration or admin screens added later.

### Requirements that shape the design

| Requirement | WCAG 2.1 criteria | How |
| --- | --- | --- |
| States never by color alone | 1.4.1 | Every state has its word: Operational, Degraded, Down, Maintenance |
| History bars have a text equivalent | 1.1.1, 1.3.1 | Each bar has a text label, and the same data is in a real table |
| Contrast: text 4.5:1, large text and graphics 3:1 | 1.4.3, 1.4.11 | Checked in light and dark themes. `buildPage()` refuses a theme or state colors from config that fail these ratios, and says which pair failed and the nearest passing value |
| Reflow at 320 CSS pixels and 200% text | 1.4.4, 1.4.10 | One column on narrow screens; the 90 days of bars wrap or scroll inside their own region, never the page |
| Text spacing | 1.4.12 | No fixed heights on text containers |
| Keyboard, visible focus, no traps | 2.1.1, 2.1.2, 2.4.7 | Native links and buttons only |
| Structure and names | 1.3.1, 2.4.2, 2.4.6, 3.1.1 | One `h1`, headings per component and section, a descriptive `<title>`, `lang` set |
| Live updates announced politely | 4.1.3 | A state change while the page is open goes to a polite live region; the page doesn't refresh itself |
| Motion | 2.2.2, 2.3.1 | No auto-playing animation; anything that moves respects `prefers-reduced-motion` |
| Time limits | 2.2.1 | None. Acknowledge links don't expire mid-task |

Meeting WCAG 2.2 AA as well costs little here (focus not obscured, target
size) and is encouraged, but 2.1 AA is the requirement.

### How it's checked

- **Every build:** axe-core with no violations on the built status page in
  each state (all operational, degraded, down, maintenance, an open incident)
  and on the acknowledge page, in light and dark themes and at 320 pixels
  wide.
- **Every release:** a manual pass with a keyboard alone, VoiceOver with
  Safari and NVDA with Firefox or Chrome, at 200% zoom and 400% zoom, with
  the result recorded in the release notes.
- **Alert emails:** rendered in at least two clients and read with a screen
  reader before a release that changes them.
- **Conformance report:** each release publishes an Accessibility
  Conformance Report (VPAT® WCAG edition) for the status page and emails.

## Availability

- **Unit:** one minute per component.
- **A minute is down when** it falls inside a confirmed incident for any
  public check in that component.
- **Excluded:** declared maintenance windows.
- **Monthly availability** per component = minutes up / (minutes in month
  minus maintenance minutes).
- **Targets and credits** are configuration: a target percentage per
  component and optional credit tiers (for example 10% below 99.9%, 25%
  below 99.0%). The monthly report states whether each target was met and
  the credit tier.
- **Output:** a monthly report per component (availability, incidents,
  minutes down, time to recover) as JSON and CSV.
- **Days and months are UTC.** Minutes before monitoring began (the first
  run of `decide()`) aren't counted, so earlier days show as no data
  rather than 100%. The current day and month count up to now.
- **Percentages round down** to three places, so a single down minute
  never shows as 100%.
- **The credit** for a month is the largest tier it falls below; a month
  above every tier owes none. `targetMet` is null without a target.
- **Time to recover** is the mean, in minutes, from start to end of the
  incidents that ended in the month.
- **Written by `decide()`** when an incident opens or resolves, and
  otherwise every 10 minutes: `public/history.json` (90 days per
  component and this month against its target) and the reports for this
  month and the last, so last month's is final once the month ends.
- **CSV columns:** `component`, `availability_percent`, `target_percent`,
  `target_met`, `credit_percent`, `minutes_counted`, `minutes_down`,
  `maintenance_minutes`, `incidents`, `mean_minutes_to_recover`.

## Storage

```
results/{region}/{yyyy}/{mm}/{dd}/{hh}{mm}.json   one file per run, in UTC: every check's result
heartbeats/{id}.json                              last success, last failure
email/{run-id}                                    round-trip messages (written by the inbox)
certificates/{check-id}.json                      last inspection and the previous fingerprint
incidents/{id}.json                               detected incidents
state/decide.json                                 open incidents by key, and each region's last results time (decide()'s own state)
state/metrics.json                                response-time histograms and degraded minutes per component
public/status.json                                current state, with the time it was written
public/history.json                               90 days of daily figures per component
public/notes.json                                 published incident and maintenance notes
public/page.json                                  the page section and components' public fields, from the config
public/reports/{yyyy}-{mm}.json|csv               monthly availability
```

Raw results expire after 90 days by default; everything else is kept.

Each file carries a `format` field naming its kind and version, such as
`belltower.results/1`, so a later version can read what an earlier one
wrote.

The public files have JSON Schemas in `packages/core/schemas/`
(`status.schema.json`, `history.schema.json`, `report.schema.json`,
`page.schema.json`),
published with `@belltower/core`. They change compatibly within a major
version: fields are only added. A test checks real output against them.

`public/status.json` is written from an allowlist: the time it was written,
the overall state, each component's name and state, the open incidents
(id, the components of their public checks, start), and each region's name and the time of its last
results. Only public checks count toward it. Nothing else
from the config, the results or the incidents is copied into it.

`public/page.json` is the only public file with config in it, also from
an allowlist: the `page` section, and each component's name, group,
description, link and target. `decide()` writes it with the history, so
a config change shows on the page within 10 minutes.

## The command line

The container adapter installs a `belltower` command. People and agents use
it the same way, so it follows these rules:

- Every input is a flag or an environment variable. Nothing prompts.
- `--json` prints one JSON object per result, with
  `"format": "belltower.cli/1"`, the `command`, `ok`, and either `result` or
  `errors`. Each error has a stable `code`, a `path` (a JSON pointer into the
  config, or the flag it's about), a `message`, and a `fix` when the
  message doesn't already say what to do.
- Exit codes are stable: 0 success, 2 usage error, 3 config invalid, 4 check
  failed, 5 platform error (the store or the network), 6 not authorized, 1
  anything unexpected.
- Commands that change something take `--dry-run`, which does the work but
  writes nothing and sends no alerts, and shows what it would have sent.
- Output names secrets; it never prints their values.

| Command | Does |
| --- | --- |
| `belltower validate` | Checks the config against the schema and the regions |
| `belltower run checks --region <name>` | Runs one region's checks once and writes its results file. For a scheduler (Kubernetes `CronJob`, Cloud Scheduler) to call every minute |
| `belltower run decide` | Runs `decide()` once. Called every minute in one place |
| `belltower notes push --dir <folder>` | Checks the incident and maintenance notes and publishes them to `public/notes.json` (see "Notes") |
| `belltower serve` | Serves `handle()` over HTTP, plus `GET /healthz` |
| `belltower serve --schedule` | Also runs every region's checks and `decide()` at the top of each minute, for a single machine. A minute whose previous run hasn't finished is skipped |

| Option | Default |
| --- | --- |
| `--config <file>`: `.json` (a `$schema` key is allowed), `.js`, `.mjs` or `.ts` with the config as its default export | `$BELLTOWER_CONFIG`, then `belltower.config.json` |
| `--regions <a,b>`: the deployment's regions | `$BELLTOWER_REGIONS`, then `local` |
| `--store <where>`: a folder for the local-folder Store, or `s3://bucket/prefix` for S3-compatible storage | `$BELLTOWER_STORE`, then `./belltower-data` |
| `--port <n>` | `$PORT`, then 8080 |

An `s3://` store reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` (for temporary credentials) and `AWS_REGION` (`auto`
for R2), plus `BELLTOWER_S3_ENDPOINT` for storage other than AWS and
`BELLTOWER_S3_PATH_STYLE` to override the addressing style. Missing ones
stop the command with exit code 3, naming them. Credentials are never
flags.

Secrets are environment variables, named in the config. On this adapter,
notifiers are webhooks and email; an SMS notifier stops the command with
exit code 3 and the notifier's path. Email goes by SMTP, set by two
secrets: `BELLTOWER_SMTP_URL` (`smtp://user:password@smtp.example.com:587`,
or `smtps://` for port 465) and `BELLTOWER_EMAIL_FROM`. A command that
would send email checks both at startup and stops with exit code 3 if
either is missing. Alert emails are plain text until the alert email
design adds an HTML part.

## Releasing it

- **Repository:** public, holding only the project. Each deployment keeps its
  config, secrets and incident notes in its own repository and installs the
  published packages.
- **License:** Apache-2.0, for its patent grant. Not AGPL, so companies can
  run it without legal review.
- **Packages:** `@belltower/core`, `@belltower/adapter-aws`,
  `@belltower/adapter-cloudflare`, `@belltower/adapter-container` (plus its
  image) and `@belltower/page`.

## Open questions

1. Whether the first release includes the Cloudflare adapter, or ships AWS
   and container first and adds Cloudflare after.
