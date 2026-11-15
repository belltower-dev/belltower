# Belltower: direction

What sets Belltower apart, and the requirements that follow from it. The
[specification](spec.md) says what Belltower does; this document says what
it's for and adds requirements the spec and [plan](plan.md) don't have yet.
When you pick one of these up, fold it into the spec and the plan's Status in
the same commit, and mark it here as moved.

## What Belltower is for

There are open-source uptime monitors already. Most are tied to one
platform, check only that a URL answers, and say nothing about accessibility.
Belltower is worth building for five reasons, and every design choice should
serve at least one of them:

1. **It conforms to WCAG 2.1 AA, with evidence.** Everything it shows people
   meets WCAG 2.1 AA, and each release publishes an Accessibility
   Conformance Report that shows it.
2. **Moving platforms loses nothing.** The same config runs on AWS,
   Cloudflare, Google Cloud, Kubernetes or a container host. Moving takes
   your full history and SLA record with you.
3. **It checks behavior, not only addresses.** Two regions must agree before
   an alert. Heartbeats catch jobs that stopped, the email round trip catches
   mail that never arrives, leak checks catch private pages that show their
   content, and certificate and domain checks give weeks of warning.
4. **Its availability numbers can go in a contract.** Monthly figures per
   component, maintenance excluded, with targets and credit tiers.
5. **Running it yourself costs about nothing.** It deploys to a serverless
   platform you already pay for, and nothing runs between checks.
6. **An agent can set it up and run it.** A coding agent pointed at an app
   can propose the checks, deploy the monitor, prove alerts arrive, and
   later read incidents and act on them, without a person clicking through
   a dashboard.

Matching a large hosted suite feature for feature is not a goal. When a
feature request doesn't serve one of the six, it waits.

## Requirements to add

### 1. Wording and scope of the accessibility claim

- Say "conforms to WCAG 2.1 AA", never "compliant", "certified" or
  "guaranteed", in the README, docs, package descriptions and release notes.
  "Compliant" reads as a legal claim; conformance is something a report can
  show.
- The claim covers what Belltower ships: the status page, alert emails, the
  acknowledge page and the docs. Say so wherever the claim appears.
- A deployment can break it with its own content. Belltower prevents what it
  can:
  - **Brand colors:** `buildPage()` already refuses pairs that fail contrast.
  - **Logo:** config requires `logo.alt`; a logo without it fails validation.
  - **Incident and maintenance notes:** `buildPage()` warns on images without
    alt text, skipped heading levels, links whose text is only "here" or a
    bare URL, and tables without header rows. Warnings, not failures, since
    the notes are the deployment's words.
- The docs list what a deployment must keep up to preserve conformance.
- Each release's conformance report says which version it covers and what
  was tested.

### 2. Moving between platforms

- **One data format.** Every stored file has a `format` field with a
  version, and a JSON Schema for each kind of file lives in the repository.
  Nothing in a file depends on the platform that wrote it.
- **`belltower move --from <store> --to <store>`.** Copies results,
  incidents, history, heartbeats, certificates and reports between any two
  stores (for example S3 to R2):
  - verifies each copied file
  - can be stopped and resumed
  - has a dry run that lists what would be copied
  - never deletes from the source
- **`belltower export`.** Writes everything to one archive of JSON and CSV,
  so data can leave even without Belltower.
- **The status page address doesn't change.** The docs show pointing a
  custom domain at the new host as the last step of a move.
- **The move is tested.** CI moves a store with a month of recorded data
  between two Store implementations, and the history and monthly figures
  come out identical.

### 3. Moving to Belltower from other tools

- An importer interface that turns another tool's exported config or API
  response into Belltower config, plus a list of what it couldn't map.
- Importers never carry secrets over silently. They list each secret the new
  config needs, by name, for the user to set.
- Ship importers for the tools people ask about, after the public release.
  Each one has tests built from that tool's real export format.

### 4. Secrets never reach the status page

- `buildPage()` reads only the `public/` files, never the config.
- `public/*.json` is written from an allowlist of fields. Nothing outside
  the allowlist is copied, so a field added later can't leak by default.
- Heartbeat tokens, basic auth, webhook URLs, phone numbers, email addresses
  and request headers never appear in a public file or the built page.
- **A test enforces it.** Build the page from a config whose every secret,
  header, token, URL query and address holds a distinct canary value, then
  fail if any canary appears anywhere in `public/` or the built site.

### 5. Timing breakdown on every HTTP check

Moved into the spec ("HTTP", "Capabilities") and built with `runChecks`.
The incident details part arrives with `decide`.

- Each result records, in milliseconds: DNS lookup, connect, TLS handshake,
  time to first byte, download, and total.
- Web-standard `fetch` only exposes the total. Each phase is optional in
  the result. An adapter that can measure the phases declares a
  `timingBreakdown` capability and fills them in; the others record the
  total only.
- Incident details show the breakdown from the first failure in each
  region, so "slow" comes with a reason (DNS, TLS, the server).
- The status page shows response time as one number. The breakdown is for
  alerts and incident details.

### 6. Webhooks that format themselves

- A webhook notifier recognizes Slack and Discord incoming-webhook URLs by
  host and sends their message formats.
- Every other URL gets a documented JSON payload: event type, check,
  component, level, regions, status code, timing, time, and the incident and
  acknowledge links.
- The payload has a version field and a JSON Schema in the repository, and
  changes only in a major release.

### 7. A public status API

- `public/status.json` and `public/history.json` are a documented API with
  JSON Schemas, readable from other sites (CORS allowed) and cached briefly.
- They stay compatible within a major version.
- The docs show embedding current status in another site with a few lines
  of code, accessibly: the state in text, with a link to the full page.

### 8. Metrics export (optional)

- An optional package, `@belltower/metrics`, sends results to Prometheus by
  remote write, or serves them in the OpenMetrics text format.
- Off by default. The core never depends on it.
- For deployments that already run Grafana; Belltower's own page and
  reports don't need it.

### 9. Deploying in ten minutes

- A template repository per platform with a GitHub Actions workflow that
  deploys on push. A user forks it, sets secrets in GitHub and edits one
  config file, with no tools installed locally.
- Config errors show in the Actions log with the field, the problem and the
  fix, before anything deploys.
- `belltower init` for people who prefer a terminal: asks for the platform
  and the first check, and writes a working config and deploy template.
- The README's quick start is timed on each platform before each release.
  The bar is ten minutes for someone who has the platform account and a
  GitHub account ready.

### 10. Built for agents

Agents are first-class users, alongside people. Every task a person can do
has a path an agent can follow without a browser and without guessing.

**A CLI an agent can drive.** This shapes the container adapter's commands,
so it starts in phase 1.

- Every command takes all its input as flags or a file. Nothing prompts
  unless it runs in a terminal and `--yes` isn't given.
- `--json` on every command, with a documented, versioned output shape.
  Errors in JSON carry a stable `code`, the config `path` (as a JSON
  pointer), a message and a `fix`.
- Exit codes are documented and stable: success, config invalid, check
  failed, platform error, not authorized.
- Commands that change something have `--dry-run`, which prints the plan,
  and are safe to run twice.
- Output never contains a secret's value, only its name.

**Commands, in the order an agent sets up a monitor:**

| Command | Does |
| --- | --- |
| `belltower suggest <path-to-app>` | Reads an app's repository and proposes checks: public routes and health endpoints, scheduled jobs (cron triggers in platform config, scheduled CI workflows) as heartbeats, domains and certificates, outgoing email as a round trip. Prints a config to review, never applies it |
| `belltower init --platform <name> --config <file>` | Writes the deploy template for a platform from a config, non-interactively |
| `belltower validate` | Checks the config against the schema and the platform's capabilities |
| `belltower try <check-id>` | Runs one check once, from where it's run, and prints the full result with timing |
| `belltower deploy --dry-run`, then `belltower deploy` | Shows, then applies, what will be created |
| `belltower verify` | Proves the setup end to end: sends a test alert through every notifier, pings each heartbeat, and confirms each region wrote a result. Reports what didn't arrive |
| `belltower heartbeat-snippet <check-id> --lang <language>` | Prints the code a job needs to ping its heartbeat, success and failure, for common languages and platforms |
| `belltower status`, `belltower incidents`, `belltower report <month>` | Read current state, incidents and availability |

**Config agents can write correctly the first time.**

- A JSON Schema for the config, published with each release, with a
  description and an example on every field.
- The config file may be JSON with a `$schema` line, so editors and agents
  validate as they write. The TypeScript form stays for people who prefer it.

**An MCP server.** Served by `handle()` from the deployment itself, over HTTP,
with a token. Phase 3.

- Read tools: status, a check's recent results, incidents with their first
  failure and timing, availability reports, upcoming certificate and domain
  expiries.
- Write tools limited to runtime state: acknowledge an incident, add an
  incident update, schedule maintenance. Config changes go through the
  config file and a deploy, so they're reviewed like code.
- Read and write tokens are separate. Every write is recorded with the
  token's name.

**Incidents an agent can act on.**

- The webhook payload (requirement 6) carries everything needed to start
  investigating without another call: the check, the request, each region's
  first failure with status, timing and the first 2 KB of the body, and the
  links. An incident can start an agent's investigation directly.

**Docs written for agents too.**

- `llms.txt` and a single-file `llms-full.txt` of the docs, generated at
  release.
- Each template repository includes an `AGENTS.md` that tells an agent how
  to add a check, run `validate`, `try` and `deploy --dry-run`, and confirm
  with `verify`.
- The README opens with a one-paragraph prompt a person can give their agent
  to set Belltower up for their app.

**Safe by default.**

- Platform credentials come from the platform's own short-lived methods
  (for example GitHub Actions OIDC), so an agent never holds long-lived keys.
- `suggest` and `init` never write secrets. They list the secret names to
  set.
- An agent can't turn off a check or delete history through any write tool;
  those need a config change.

### 11. A status page people already know how to read

Status pages share conventions that visitors recognize. Belltower follows
them, and meets WCAG 2.1 AA while doing it.

**Layout and states**

- An overall status line with "Last updated" and its time.
- Components in groups (by region, by function, or both) that expand and
  collapse with a button that says what it does. Each component can have a
  one-line description and a link to the thing itself ("Web app" to the app).
- Five component states, always in words: Operational, Degraded
  performance, Partial outage (some regions or some of the feature), Major
  outage, Maintenance. A legend lists them.
- 90-day bars per component with uptime percentages, and a response time
  chart per component, each with a table alternative.
- Separate pages for Status, Maintenance and History, so the main page stays
  short.
- System, light and dark themes, following the viewer's setting by default.
- Times in the viewer's time zone, with UTC shown alongside.
- A "Report a problem" link, set in config.

**Incidents**

- Every incident has its own page and a permanent link, for sharing during an
  outage.
- Updates carry a stage and a time: Investigating, Identified, Monitoring,
  Resolved, plus plain Update. The stage is a word, not only an icon.
- Each incident shows its duration, the components it affected and its
  impact, including "No impact" when components were named for context.
- History lists every day, with "No incidents reported" on quiet days. An
  empty day is evidence too.

**Subscribing**, in this order:

1. Atom and RSS feeds of incidents and maintenance (phase 2).
2. Email, confirmed with a one-time code, for incidents created, updated and
   resolved; with a choice of components (phase 3).
3. Webhooks, for incidents and component state changes, with an email
   address that hears if the webhook keeps failing (phase 3).
4. Slack (phase 4). SMS only if deployments ask.

Every subscription has a one-click unsubscribe, and the subscribe form is
protected against bots without a visual puzzle (puzzles fail accessibility).

**Machine-readable status**

- `summary.json` follows the shape widely used by status page widgets and
  aggregators (page, overall status indicator, components, open incidents,
  scheduled maintenance), so existing tools read a Belltower page without
  changes. `status.json`, `history.json` and the feeds sit alongside
  (requirement 7).

**Later**

- A hub page listing several products' status pages, for deployments with
  more than one product.
- Private pages, signed in by SSO or an emailed code, for internal services.

### 12. Branding

Each deployment's page looks like its own product, in ways that can't break
accessibility.

- **From config:**
  - name and link
  - logo, plus a separate logo for dark mode, each with required alt text
  - favicon
  - accent color
  - font (a system font stack by default; a web font only from the
    deployment's own host)
  - default theme
  - footer text and links
- **Contrast is checked at build:** the accent color is tested against both
  themes' backgrounds and text, and a failing pair stops the build with the
  pair and the ratio.
- **No custom CSS or scripts.** They're how branding breaks accessibility,
  and what the build can't check.
- **Domain:** the page is served from the deployment's own domain. The docs
  show the DNS record for each static host.
- **Email** (subscriptions and alerts) comes from a sender name and address
  set in config, on the deployment's own domain.
- **Footer:** "Powered by Belltower", on by default, can be turned off in
  config.

### 13. Alerting that a small team can run

Enough alerting that nobody needs a second tool to be woken up, without
becoming an on-call scheduling product.

- **One incident per problem.** Repeated failures of a check fold into its
  open incident. Related checks can share an incident key, so a database
  outage that breaks five checks is one incident with five checks.
- **Priorities, P1 to P5,** set per check and component, replacing the
  two-level `severity`. Priority picks the channels: for example, P1 texts,
  P3 emails, and P5 only records.
- **Acknowledge and resolve from the alert itself:** signed links in email
  and SMS, and buttons in Slack. The acknowledge page meets WCAG 2.1 AA.
- **Simple escalation:** an alert that isn't acknowledged within a set time
  goes to the next contact in a list, then the next. No rotations or
  calendars.
- **Quiet hours per contact:** lower priorities wait until morning; P1 and
  P2 never wait.
- **An inbound alert API.** Other tools (a CI job, an error tracker, a
  queue's dead-letter check) open, update and resolve incidents by HTTP with
  a token. Those incidents follow the same rules and show on the page under
  the component they name, so the status page is the one place for any
  outage.
- **Out of scope:** on-call rotations and calendars, teams, routing rules.
  Deployments that need them use a dedicated tool, which Belltower notifies
  by webhook.

## Where each requirement goes

| Requirement | Phase |
| --- | --- |
| 5. Timing breakdown | 1, with `runChecks` |
| 4. Secrets never reach the page | 2, with `buildPage()` |
| 7. Public status API | 2 |
| 1. Accessibility wording and scope | 2, and every release after |
| 6. Webhooks that format themselves | 3, with the notifiers |
| 2. Moving between platforms | 4, before the public release |
| 9. Deploying in ten minutes | 4 |
| 3. Importers | After the public release |
| 8. Metrics export | Later |
| 10. Built for agents: CLI rules (flags, `--json`, exit codes, `--dry-run`) | 1, with the container adapter's commands |
| 10. `validate`, `try`, `deploy`, `verify`, `heartbeat-snippet`, the config JSON Schema | 2 and 3 |
| 10. MCP server, incident payloads for agents | 3 |
| 10. `suggest`, `init`, `llms.txt`, template `AGENTS.md`, README prompt | 4 |
| 11. Layout, five states, groups, incident pages and stages, daily history, themes, local time, feeds, `summary.json` | 2, with `buildPage()` |
| 11. Email and webhook subscriptions | 3 |
| 11. Slack subscriptions | 4 |
| 11. Hub page, private pages | Later |
| 12. Branding from config, contrast check, sender address | 2, and email in 3 |
| 13. Incident keys, priorities | 1 and 2, with `decide` (priorities replace `severity`) |
| 13. Acknowledge and resolve from alerts, escalation, quiet hours | 3, with the notifiers |
| 13. Inbound alert API | 3 |

## Moved into the spec and plan

- 1. Accessibility wording and scope, in part: the warnings on incident
  and maintenance notes (alt text, link text, heading levels, table
  headers) are in the spec's "Notes", from `belltower notes push`. The
  logo's alt text and the wording rules come with `buildPage()`.
- 7. Public status API, in part: JSON Schemas for `status.json`,
  `history.json` and the monthly report, with the compatibility rule, are
  in the spec's "Storage". CORS, caching and the embedding docs come with
  `buildPage()` and hosting.
- 10. CLI rules (flags only, `--json` with codes, JSON pointers and fixes,
  stable exit codes, `--dry-run`, no secret values): the spec's "The
  command line", built in the container adapter. `validate` is there too.
  The other commands are still to come in their phases.
- 5. Timing breakdown: results, the `timingBreakdown` capability and the
  HttpClient port. Incidents keep each region's first failure, timing
  included; showing it to people comes with the status page and alert
  emails.
