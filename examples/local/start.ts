import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * Starts the demo service and Belltower side by side. Belltower runs two
 * regions on this one machine, so the rule that two regions must agree
 * before an alert is exercised too.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cli = fileURLToPath(import.meta.resolve("@belltower/adapter-container/cli"))

const env = {
  ...process.env,
  ALERT_WEBHOOK_URL: "http://localhost:3000/alerts",
  DEMO_JOB_TOKEN: process.env.DEMO_JOB_TOKEN ?? "demo-job-token",
  BELLTOWER_URL: "http://localhost:8080",
}

const children = [
  spawn(process.execPath, [join(here, "demo-service.ts")], { env, stdio: "inherit" }),
  spawn(
    process.execPath,
    [cli, "serve", "--schedule", "--config", join(here, "belltower.config.json"), "--store", join(here, "belltower-data"), "--regions", "local-a,local-b", "--port", "8080"],
    { env, stdio: "inherit" },
  ),
]

const stop = () => children.forEach((c) => c.kill("SIGTERM"))
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
for (const child of children) child.once("exit", (code) => code && code !== 0 && stop())
