# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## More commands

```sh
pnpm test packages/core/test/capabilities.test.ts   # one file
pnpm test -t "judges heartbeats"                    # tests whose name matches
pnpm exec vitest                                    # watch mode
```

There is no build step. `@belltower/core` exports its `.ts` source directly
(`"exports": { ".": "./src/index.ts" }`), and `pnpm typecheck` only covers
`packages/core`; add new packages to that script when they appear.

## TypeScript settings that bite

From `tsconfig.base.json`:

- Relative imports carry the `.ts` extension (`from "./ports.ts"`), and
  type-only imports use `import type` (`verbatimModuleSyntax`).
- `exactOptionalPropertyTypes`: an optional field can be absent but can't be
  set to `undefined` unless its type says so.
- `noUncheckedIndexedAccess`: indexing a record or array gives `T | undefined`.
- `packages/core/tsconfig.json` sets `"types": []`, so Node globals are not
  visible there. If something only typechecks with `@types/node`, it belongs
  in an adapter.

## How the pieces fit

The design lives in `docs/spec.md`; this is the map.

- **Four entry points** the platform calls: `runChecks(region)` every minute
  in each region writes one results file; `decide()` runs once per deployment
  every minute, reads all regions' results and applies the confirmation and
  recovery rules (two regions, consecutive minutes), opens incidents and
  sends alerts; `handle(request)` is a standard fetch handler for heartbeat
  pings and acknowledge links; `buildPage()` writes the static status page.
- **Regions only share the Store.** They are separate schedules writing to
  one object store with read-after-write consistency. The key layout
  (`results/{region}/...`, `heartbeats/`, `incidents/`, `public/...`) is in
  the spec's "Storage" section and is the contract between entry points.
- **Ports** (`packages/core/src/ports.ts`) are everything an adapter supplies:
  Store, Notifier, Secrets, and the optional Inbox and TlsInspector, plus
  Clock. Optional ports map to `Capabilities` flags.
- **`assignChecks`** (`packages/core/src/capabilities.ts`) decides which
  region runs each check from those flags. HTTP checks run in every capable
  region; heartbeat, email, tls and domain checks go to the first capable
  region only. A check no region can run is an error that says how to fix it.
- **Adapters** (`aws`, `container`, `cloudflare`, all planned) wire ports to a
  platform. The planned repository layout is in `docs/plan.md`, including
  contract suites under `packages/core/test/` that every adapter must pass.
