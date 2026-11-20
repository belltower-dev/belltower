# Belltower: build plan

How to build what [spec.md](spec.md) describes. Each phase ends with
something a deployment can run, and lists its done-when checks.

Phases 1 to 3 build Belltower on the `aws` adapter, with the `container`
adapter for local runs and CI. Phase 4 adds Cloudflare and the deploy
examples, and makes the repository public.

## Status

Update this section in the same commit as the work it describes.

**Now:** phase 1's code is built. Its remaining done-when checks need a
real AWS deployment of `examples/aws-sam`.

**Done:**

- Workspace, TypeScript, Vitest, license, README.
- Ports (`packages/core/src/ports.ts`): Store, Notifier, Secrets, Inbox,
  TlsInspector, Clock, Capabilities.
- `assignChecks` (`packages/core/src/capabilities.ts`): checks go to the
  regions that can run them; configs no region can run are refused with a
  fix. Tested.
- `validateConfig` (`packages/core/src/config.ts`): every check type's
  fields and defaults, components, notifiers and thresholds; errors name the
  field and suggest typos; calls `assignChecks`. Tested.
- `runChecks` for HTTP checks (`packages/core/src/check.ts`): parallel
  requests with timeouts, status and keyword rules, timing (with the
  breakdown when the adapter's HttpClient reports it), failure details,
  one results file per run. `skipTlsVerify` and `timingBreakdown`
  capabilities. Tested with a fake HttpClient.
- Store contract suite (`packages/core/test/contracts/store.ts`, exported as
  `@belltower/core/contracts`), passed by the in-memory Store in the core
  and the local-folder Store in `packages/adapter-container`.
- `decide` for HTTP checks (`packages/core/src/decide.ts`): the
  confirmation, degraded and recovery rules as a pure `judge`; incidents
  with first failures per region; alerts on open and recovery;
  `public/status.json`. Tested with recorded results.
- Heartbeats (`packages/core/src/heartbeat.ts`): `handle` records success
  and failure pings; `decide` judges them and alerts on a miss or a
  failure. Tested.
- Structured config issues (code, JSON pointer, message, fix) and a
  webhook notifier in the core.
- `adapter-container` so far: local-folder Store, `nodeHttpClient` (skips
  TLS verification on request, reports DNS, connect and TLS times), and the
  `belltower` CLI (`validate`, `run checks`, `run decide`, `serve`,
  `serve --schedule`) following the CLI rules in the spec's "The command
  line". Tested.

- `examples/local`: the whole monitor on one machine against a demo
  service whose alerts arrive by webhook. Run for real: outages, a leak and
  a missed heartbeat alerted and recovered within the target times.
- Email alerts from the container adapter by SMTP (nodemailer), set by
  `BELLTOWER_SMTP_URL` and `BELLTOWER_EMAIL_FROM`. Plain text for now.
- `s3Store` in the core (S3 API over fetch with SigV4 on Web Crypto), and
  `--store s3://bucket/prefix` in the CLI. Contract-tested against a fake
  S3; a live contract test runs when `BELLTOWER_S3_TEST_ENDPOINT` is set.

- `adapter-aws`: Lambda handlers for checks, decide and a function URL;
  S3 through `s3Store`, SSM secrets, SES email and SNS SMS, all over fetch
  with SigV4. Tested against a fake AWS.

- `examples/aws-sam`: a SAM template (checks in every region; the bucket,
  decide and a heartbeat function URL in the primary region) and a demo
  config. Not yet deployed.

- Phase 2 so far: component targets and credit tiers in the config; the
  daily roll-up into `public/history.json` and monthly reports as JSON and
  CSV, written by `decide()`; JSON Schemas for the public files;
  incident and maintenance notes in Markdown, published by
  `belltower notes push`, with maintenance holding back incidents, alerts
  and downtime, and accessibility warnings on note content. Tested.
- esbuild in `examples/aws-sam`; the Lambda bundle is 140 KB with the page builder (ES module builds first, so Lucide is tree-shaken).
- Priorities P1 to P5 on checks and components, notifiers that send up to
  a priority, and incident keys that fold related checks into one
  incident. Tested.
- What the status page reads: five component states; component groups,
  descriptions and links; the `page` config, published as
  `public/page.json`; notices, impact, stages and component states in
  notes; each region's last results time in `status.json`; response-time
  medians and degraded minutes per day in `history.json`; `summary.json`
  and the Atom, RSS and JSON feeds, built from the public files. Tested.
- `buildPage()`: the static status page in the hub layout, reviewed as a
  preview. Plain CSS in the shadcn/ui look on the theme's own variables,
  Lucide icons inlined, the contrast check in both modes before anything
  is written, one layout for phones and wide screens, Markdown copies,
  `llms.txt`, and `belltower page build`. Per-day minutes in partial and
  major outage color the 90-day bars. Tested.
- `decide()` rebuilds the page beside `status.json` when something
  changes and at least every 10 minutes, given `BELLTOWER_SITE_URL` (or
  the `SiteUrl` parameter in `examples/aws-sam`); `notes push` rebuilds
  it at once. Tested.
- Fonts a theme names are fetched once from Google Fonts at build and
  served from the page's own `fonts/` folder; the Store port takes bytes.
  Tested, and checked against Google Fonts with real families.

**Next, in order:**

1. Deploy `examples/aws-sam` to three regions and run phase 1's remaining
   done-when checks.

Phase 1's done-when checks are below.

## Repository

```
packages/
  core/                  no platform code
    src/check.ts         runChecks(region)
    src/decide.ts        confirmation and recovery rules, incidents, alerts
    src/heartbeat.ts     handle(request): /hb/{token}, /hb/{token}/fail
    src/certificates.ts  the rules in certificates.md, on inspection results
    src/domains.ts       RDAP lookup and rules
    src/availability.ts  monthly figures, maintenance exclusion
    src/ports.ts         Store, Notifier, Secrets, Inbox, TlsInspector, Clock
    src/config.ts        config schema, validation against adapter capabilities
    test/                pure tests, and contract suites every adapter must pass
  adapter-aws/           Lambda handlers, S3 store, SES and SNS notifiers, SSM secrets, TLS inspector
  adapter-container/     Node HTTP server and `run` CLI, S3-compatible and local-folder stores, SMTP and webhook notifiers, TLS inspector
  adapter-cloudflare/    phase 4
  page/                  buildPage(): the static status page
examples/
  aws-sam/               a deployable template and a demo config
  local/                 the whole monitor on one machine against a local folder
```

## Phase 1: checks, heartbeats, alerts

| Step | Notes |
| --- | --- |
| Ports and config schema, with validation against declared capabilities | `ports.ts`, `config.ts` |
| `runChecks`: HTTP checks in parallel with timeouts, keyword and reject rules, one results file per run | |
| `decide`: confirmation, degraded and recovery rules; incidents; email alerts on open and recovery; `public/status.json` with its write time | |
| `handle`: heartbeat success and fail endpoints; missed period plus grace counts as down | |
| Store contract suite: `get`, `put`, `list`, read-after-write | Run against S3 (MinIO in CI) and the local folder |
| `adapter-aws`: Lambda handlers, EventBridge schedules, function URL, S3, SES, SSM | |
| `adapter-container`: HTTP server for `handle`, `run checks`, `run decide` commands | Used for local runs and CI |
| `examples/aws-sam` and `examples/local` | |

### Done when

- [x] The local example runs every minute against a demo service and a
      fake notifier.
- [ ] On AWS with three regions, every region writes a results file every
      minute for 24 hours.
- [ ] One region failing alone raises no alert. All regions failing alerts
      within three minutes and recovers within four minutes of the fix.
- [ ] A heartbeat that misses its period plus grace alerts; a `/fail` alerts
      at once; the next success recovers.
- [ ] A `rejectKeyword` check with priority P1 alerts by SMS when the phrase appears.
- [ ] No `@aws-sdk` or Node built-in import in `packages/core`.

## Phase 2: status page and availability

| Step | Notes |
| --- | --- |
| Daily roll-up into `public/history.json`, 90 days per component | |
| Monthly report as JSON and CSV, with targets and credit tiers from config | |
| Incident and maintenance notes from Markdown; maintenance suppresses alerts and downtime | |
| `buildPage()`: static page, Atom, RSS and JSON feeds, Markdown copies and `llms.txt`, branding from config | |
| Accessibility: the requirements in the spec's "Accessibility" section; axe-core in CI on every page state, light and dark, at 320 pixels | WCAG 2.1 AA, a release requirement |
| Brand colors from config checked for contrast at build | Fails the build with the failing pair |
| Freshness: document how a deployment alerts when `status.json` is stale | The monitor can't watch itself |

### Done when

- [ ] The page shows components, overall state, 90-day bars with text
      labels, this month against target, incidents and maintenance.
- [ ] With JavaScript off, it shows the state as of the last build.
- [ ] Each page's Markdown copy says the same as the page, and `llms.txt`
      lists every page, JSON file and feed.
- [ ] axe-core reports no violations on every page state, and a manual pass
      (keyboard, VoiceOver, NVDA, 200% and 400% zoom) finds no WCAG 2.1 AA
      failures.
- [ ] A forced outage appears on the page within two minutes and in that
      day's bar and the month's figure.
- [ ] A maintenance window keeps its minutes out of downtime and suppresses
      alerts.

## Phase 3: email, certificates, domains, SMS

| Step | Notes |
| --- | --- |
| Email round trip: Inbox port, SES inbound adapter, the run ID matched against the heartbeat | |
| TLS inspector in the aws and container adapters; the rules in [certificates.md](certificates.md) | Including `addresses: all` |
| Domain checks over RDAP, with the bootstrap file cached a day | |
| SMS through SNS; Twilio as a generic notifier | |
| Repeat alerts every 30 minutes until acknowledged by a signed link | The acknowledge page meets WCAG 2.1 AA |
| Alert emails: semantic HTML plus a plain-text part | Checked in two clients and with a screen reader |
| Contract tests against the badssl.com hosts | Certificates |

### Done when

- [ ] A canary email is matched; blocking it alerts after the set time.
- [ ] Each badssl.com host produces its expected finding.
- [ ] A recorded 47-day certificate warns when a third of its life is left
      and alerts at seven days.
- [ ] A domain with no RDAP expiration reports Unsupported, never Up.
- [ ] A P1 check texts, repeats after 30 minutes and stops once
      acknowledged.

## Phase 4: Cloudflare, deploy examples, public release

| Step | Notes |
| --- | --- |
| `adapter-cloudflare`: Workers handlers, Cron Triggers, R2, Email Service, Email Routing inbox | |
| Its TLS startup probe; the Certificate Transparency fallback; the deploy check suggesting a Node region | [certificates.md](certificates.md) |
| Container image on GitHub Container Registry | |
| Examples: `wrangler.jsonc`, Terraform for Cloud Run with Cloud Scheduler, Kubernetes `CronJob` manifests, Knative with `PingSource` | Each deploys the same demo config |
| CI: core tests, and the Store contract suite against MinIO, local R2 and the Cloud Storage emulator | |
| README with a 30-minute quick start per platform, and "run it somewhere other than what it watches" | |
| `LICENSE` (Apache-2.0), `SECURITY.md`, `CONTRIBUTING.md`, semantic versioning, a changelog | `CONTRIBUTING.md` states the WCAG 2.1 AA requirement and how to run the checks |
| Accessibility Conformance Report for the status page and emails | Published with the release |
| Publish the packages and make the repository public | After it has run a real deployment for a month |

### Done when

- [ ] The demo config runs on AWS, Cloudflare and Cloud Run, and the same
      forced outage opens and closes an incident on each.
- [ ] Someone new deploys it from the README in under 30 minutes on one
      platform.
- [ ] The release's manual accessibility pass and its conformance report
      are published.

## Later

- A scripted browser check (sign-in and similar flows), which needs a
  headless browser on the platform.
- Status page subscriptions by email, then SMS and webhook: double
  opt-in, unsubscribe links, subscriber files kept out of `public/` and
  carried by `move` and `export`.
- A phone call notifier on the SMS provider.
- More notifiers (Slack and Teams beyond webhooks, paging services) as
  people ask.
- Ping, TCP, UDP, DNS, SMTP, POP and IMAP check types, each behind a port
  and a capability so `assignChecks` places it where it can run.
