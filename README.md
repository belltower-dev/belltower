# Belltower

An open-source uptime monitor and status page that runs on any serverless
platform: AWS Lambda, Cloudflare Workers, Google Cloud Run, Kubernetes, or
any host that runs a container.

Belltower checks real behavior, not only whether a URL answers:

- an outage is declared only when two regions agree
- scheduled jobs report in, so a job that stopped is noticed
- an email round trip catches mail that never arrives
- a page that should stay private is checked for leaks
- certificates and domains are watched long before they expire

It publishes a status page and the monthly availability figure an SLA is
measured against. Everything it shows people meets WCAG 2.1 AA.

**Status:** design and early code. Nothing to deploy yet.

Source: <https://github.com/acrstatus/belltower>

## Design

- [Specification](docs/spec.md)
- [Certificate and domain checks](docs/certificates.md)
- [Build plan](docs/plan.md)

## Packages

| Package | What it is |
| --- | --- |
| `@belltower/core` | The platform-free core: checks, decisions, heartbeats, availability |
| `@belltower/adapter-aws` | Lambda, EventBridge Scheduler, S3, SES and SNS (planned) |
| `@belltower/adapter-container` | A Node server and CLI for Cloud Run, Knative, Kubernetes and others (planned) |
| `@belltower/adapter-cloudflare` | Workers, Cron Triggers, R2 and Email Service (planned) |
| `@belltower/page` | The static status page (planned) |

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE).
