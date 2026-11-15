# Belltower: build plan

How to build what [spec.md](spec.md) describes. Each phase ends with
something a deployment can run, and lists its done-when checks.

Phases 1 to 3 build Belltower on the `aws` adapter, with the `container`
adapter for local runs and CI. Phase 4 adds Cloudflare and the deploy
examples, and makes the repository public.

## Status

Update this section in the same commit as the work it describes.

**Now:** phase 1.

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

**Next, in order:**

1. `decide` and its rules, pure and tested with recorded results.
2. `handle` for heartbeats.
3. The rest of `adapter-container`, then `examples/local`: the first thing
   that runs end to end.
4. `adapter-aws` and `examples/aws-sam`.

Phase 1's done-when checks are below. Things built but not yet tried for
real go in [untested.md](untested.md).

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

- [ ] The local example runs every minute against a demo service and a
      fake notifier.
- [ ] On AWS with three regions, every region writes a results file every
      minute for 24 hours.
- [ ] One region failing alone raises no alert. All regions failing alerts
      within three minutes and recovers within four minutes of the fix.
- [ ] A heartbeat that misses its period plus grace alerts; a `/fail` alerts
      at once; the next success recovers.
- [ ] A `rejectKeyword` check alerts as critical when the phrase appears.
- [ ] No `@aws-sdk` or Node built-in import in `packages/core`.

## Phase 2: status page and availability

| Step | Notes |
| --- | --- |
| Daily roll-up into `public/history.json`, 90 days per component | |
| Monthly report as JSON and CSV, with targets and credit tiers from config | |
| Incident and maintenance notes from Markdown; maintenance suppresses alerts and downtime | |
| `buildPage()`: static page, Atom feed, branding from config | |
| Accessibility: the requirements in the spec's "Accessibility" section; axe-core in CI on every page state, light and dark, at 320 pixels | WCAG 2.1 AA, a release requirement |
| Brand colors from config checked for contrast at build | Fails the build with the failing pair |
| Freshness: document how a deployment alerts when `status.json` is stale | The monitor can't watch itself |

### Done when

- [ ] The page shows components, overall state, 90-day bars with text
      labels, this month against target, incidents and maintenance.
- [ ] With JavaScript off, it shows the state as of the last build.
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
- [ ] A critical check texts, repeats after 30 minutes and stops once
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
- Status page subscriptions by email.
- More notifiers (Slack and Teams beyond webhooks, PagerDuty) as people ask.
- Ping, TCP and DNS check types.
