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

The feature set follows the uptime part of hosted products such as Better
Stack (monitor settings, heartbeats, incidents, status pages, reporting), cut
to what a small team needs.

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

- On-call schedules, call routing, escalation across a team. One alert list.
- Phone call alerts. Email, SMS and webhooks.
- Logs, traces, metrics, error tracking, session replay. Use an APM tool.
- AI incident investigation, a post-mortem tool. Post-mortems are Markdown in
  the deployment's repository.
- Ping, TCP, UDP, SMTP, POP, IMAP and DNS monitor types in the first version.
- Status page subscriptions by email, SMS or webhook in the first version. An
  Atom feed only.

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

The store must give read-after-write consistency and be reachable from every
region. S3, R2 and Google Cloud Storage all do.

### Adapters

| Adapter | Runs on | Schedules with | Store, email, TLS |
| --- | --- | --- | --- |
| `aws` | Lambda (Node) | EventBridge Scheduler | S3, SES and SNS, TLS inspector |
| `cloudflare` | Workers | Cron Triggers | R2, Email Service and Email Routing; TLS inspector only if the startup probe passes ([certificates.md](certificates.md)) |
| `container` | A Node server image with a `run` command | Cloud Scheduler with Cloud Run, Knative `PingSource`, Kubernetes `CronJob`, Fly, Railway | Any S3-compatible store or Cloud Storage; SMTP, Resend, webhooks; TLS inspector |

The container adapter covers Google Cloud, Kubernetes and most other hosts,
so three adapters reach nearly everything.

### Capabilities

Each adapter declares what it supports (`tlsInspector`, `inbox`, `sms`). At
deploy, the config is checked against the regions it runs in:

- A check is assigned only to regions whose adapter supports it. A daily
  certificate check can run from one Node region while HTTP checks run from
  Workers regions.
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
| `severity` | `normal` or `critical` (critical also sends SMS) | `normal` |
| `public` | Whether it shows on the status page | `true` |

Checks send the user agent `Belltower/<version>` so the watched service
can leave them out of its analytics and rate limits.

### HTTP

- **Fails when** the request errors, times out, returns a status outside
  `expectStatus`, misses `expectKeyword` or contains `rejectKeyword`.
- `rejectKeyword` is how a deployment checks that protected content stays
  protected: request a private page signed out and reject a phrase from its
  body. Mark such checks `critical`, since a failure is a data exposure, not
  an outage.

### Heartbeats

For scheduled jobs: a URL check can't see a job that stopped.

| Field | Meaning |
| --- | --- |
| `period` | How often a success is expected |
| `grace` | Extra time before a missing success counts as down |
| `token` | Secret part of the ping URL |

- The job calls `GET {handle}/hb/{token}` when it succeeds and
  `/hb/{token}/fail` when it fails.
- Down when no success arrives within period plus grace, or a `/fail`
  arrives. Up again on the next success.
- States: `pending` (no ping yet), `up`, `down`, `maintenance`, `paused`.
- A failed ping must never fail the job that sends it.

### Email round trip

For services that send email: a delivery problem never shows on a web check.

- The watched service sends a message to an address the inbox port can read,
  with a run ID, on a schedule.
- The service also sends its heartbeat with the same run ID.
- Down when the message hasn't arrived a set time (default 30 minutes) after
  that heartbeat.
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

## Incidents and alerts

- **Opened automatically** when a check is confirmed down, starting at the
  first failing minute.
- **Each incident keeps** the check, component, regions, start and end, and
  from the first failure in each region: status code, timing, response
  headers and the first 2 KB of the body.
- **Alerts:**
  - On open and on recovery, through every configured notifier.
  - SMS only for `critical` checks and for components marked critical.
  - The open alert repeats every 30 minutes until acknowledged, by a signed
    link in the alert.
- **Resolved automatically** on recovery; the recovery alert gives the
  duration.
- **Public incident notes** are Markdown files in the deployment's
  repository, written by hand: title, component, start, end, updates with
  times. A detected incident shows as "Detected outage" until a note exists.
- **Who watches Belltower:** `public/status.json` carries the time it was
  written. The deployment should have something outside Belltower (the
  watched service itself, or a free external check) alert when it's more
  than 10 minutes old.

## Maintenance

- Declared by a Markdown file with component, start and end.
- During the window, checks still run; failures don't alert and don't count
  as downtime.
- Shown on the status page from the moment the file is published.

## Status page

- **Components** as configured. Heartbeat, certificate and domain checks are
  usually internal (`public: false`).
- **Overall state:** the worst state of any component.
- **Component states,** in words, never color alone: Operational, Degraded,
  Down, Maintenance.
- **History:** 90 days per component, one bar a day.
  - Each bar has a text label: date, uptime percentage, incidents.
  - Under the bars: this month's availability next to the configured target.
- **Incidents:** open first, then the last 90 days, each with its updates.
  Maintenance announcements above.
- **Feed:** Atom feed of incidents and maintenance.
- **Built** as static HTML by `buildPage()`, deployable to any static host
  (GitHub Pages, S3, R2, Cloud Storage, Netlify). It reads
  `public/status.json` and `public/history.json`. Without JavaScript it shows
  the state as of the last build.
- **Accessible:** WCAG 2.1 AA, as for everything Belltower shows people
  ("Accessibility", below).
- **Branding:** name, logo, link and colors from config.

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
| Contrast: text 4.5:1, large text and graphics 3:1 | 1.4.3, 1.4.11 | Checked in light and dark themes. `buildPage()` refuses brand colors from config that fail these ratios, and says which pair failed |
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

## Storage

```
results/{region}/{yyyy}/{mm}/{dd}/{hh}{mm}.json   one file per run: every check's result
heartbeats/{id}.json                              last success, last failure
email/{run-id}                                    round-trip messages (written by the inbox)
certificates/{check-id}.json                      last inspection and the previous fingerprint
incidents/{id}.json                               detected incidents
public/status.json                                current state, with the time it was written
public/history.json                               90 days of daily figures per component
public/reports/{yyyy}-{mm}.json|csv               monthly availability
```

Raw results expire after 90 days by default; everything else is kept.

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
