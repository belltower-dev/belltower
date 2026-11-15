# Working on Belltower

Belltower is an open-source uptime monitor and status page that runs on any
serverless platform. Read [docs/spec.md](docs/spec.md) before changing
behavior, [docs/certificates.md](docs/certificates.md) before touching
certificate or domain checks, and [docs/plan.md](docs/plan.md) for what's
built next.

## Rules

- **No deployment specifics.** Belltower is for everyone. Never put a
  particular company's name, domains, checks or secrets in code, docs,
  examples or tests. Use `example.com` and made-up services. Each deployment
  keeps its config in its own repository.
- **The core stays platform-free.** `packages/core` uses web-standard APIs
  only (`fetch`, `Request`, `Response`, Web Crypto, `URL`). No Node built-ins
  and no cloud SDKs there; those belong in an adapter.
- **Pure where it can be.** Rules take data in and return data, with time
  passed in (`Clock`), so they're tested without a platform.
- **Capabilities, not assumptions.** If a feature needs something only some
  runtimes have (reading a TLS certificate, an inbox), it goes behind a port
  and a declared capability, and `assignChecks` refuses configs no region can
  run.
- **WCAG 2.1 AA is a release requirement** for everything Belltower shows
  people: the status page, alert emails, the acknowledge page, the docs. See
  the spec's "Accessibility" section. A change that fails it doesn't merge.
- **Docs move with the code.** When behavior changes, update the spec, and
  the plan's done-when checks if they're affected, in the same commit.

## Commands

```sh
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc on packages/core
```

## Writing

For docs, comments, alert text and the status page:

- Plain, specific sentences. Say what something does, not that it's
  powerful or seamless.
- No em dashes.
- Avoid the patterns that make text read as generated: "not X, but Y",
  matched pairs of clauses, three-part lists that end in a summary phrase.
- States and errors say what happened and what to do next.

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), an
imperative title under 60 characters, then a short list of what changed.
