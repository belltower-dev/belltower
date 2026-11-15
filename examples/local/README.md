# Belltower on one machine

Runs the whole monitor locally against a demo service, so you can watch an
outage get confirmed, alerted and resolved without deploying anything.

It starts two processes:

- **The demo service** on port 3000: a shop page, a private account page,
  a scheduled job that pings its heartbeat every 30 seconds, and an
  `/alerts` endpoint that prints the alerts Belltower sends it.
- **Belltower** on port 8080, running `belltower serve --schedule` with two
  regions, `local-a` and `local-b`. Each minute both regions run the checks
  and `decide()` judges the results, so the rule that two regions must agree
  before an alert applies here too.

Results, incidents and `public/status.json` go to `belltower-data/`.

## Run it

You need Node 22.18 or later, and pnpm.

```sh
pnpm install
pnpm --filter belltower-example-local start
```

Within a minute you'll see each region report its checks.

## Things to try

In a second terminal:

| Command | What happens |
| --- | --- |
| `curl -X POST localhost:3000/mode/down` | The shop answers 503. About two to three minutes later the demo service prints a Down alert for `shop-home` |
| `curl -X POST localhost:3000/mode/up` | Three passing minutes later, a Recovered alert with the outage's duration |
| `curl -X POST localhost:3000/mode/slow` | The shop takes 3 seconds, over its 2-second `slowSeconds`. After five minutes `public/status.json` shows Shop as degraded, with no alert |
| `curl -X POST localhost:3000/mode/leak` | The private page shows its content. `account-private` fails on its `rejectKeyword` and alerts |
| `curl -X POST localhost:3000/job/stop` | The job stops pinging. Once its period plus grace (two minutes) passes, `demo-job` alerts |
| `curl -X POST localhost:3000/job/start` | The next ping recovers it |

Look at the state at any time:

```sh
cat belltower-data/public/status.json
ls belltower-data/incidents
```

## What's in the config

`belltower.config.json` has three checks: an HTTP check that needs the shop's
welcome text, a check that the account page stays private (status 401, and
never the phrase "Account balance"), and a heartbeat for the job. Alerts go
to one webhook notifier whose URL is the `ALERT_WEBHOOK_URL` environment
variable, which `start.ts` points at the demo service.

To run the same monitor against your own service, copy the config, change
the checks, and run:

```sh
belltower validate --config belltower.config.json
belltower serve --schedule --config belltower.config.json
```
