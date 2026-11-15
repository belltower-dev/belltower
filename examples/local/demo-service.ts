import { createServer } from "node:http"

/*
 * A pretend service for Belltower to watch, and a pretend inbox for its
 * alerts. Switch its behavior while the monitor runs:
 *
 *   curl -X POST localhost:3000/mode/down    the shop answers 503
 *   curl -X POST localhost:3000/mode/slow    the shop takes 3 seconds
 *   curl -X POST localhost:3000/mode/leak    the private page shows its content
 *   curl -X POST localhost:3000/mode/up      everything works again
 *   curl -X POST localhost:3000/job/stop     the job stops pinging its heartbeat
 *   curl -X POST localhost:3000/job/start    the job pings again
 *
 * Alerts Belltower sends to /alerts are printed here.
 */

type Mode = "up" | "down" | "slow" | "leak"
let mode: Mode = "up"
let jobRunning = true

const port = Number(process.env.DEMO_PORT ?? 3000)
const belltower = process.env.BELLTOWER_URL ?? "http://localhost:8080"
const token = process.env.DEMO_JOB_TOKEN ?? ""

const log = (line: string) => console.log(`[demo ${new Date().toISOString().slice(11, 19)}] ${line}`)

createServer((req, res) => {
  const path = req.url ?? "/"
  const send = (status: number, body: string) => res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body)

  if (req.method === "POST" && path === "/alerts") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const alert = JSON.parse(body) as { level: string; title: string; text: string }
      log(`ALERT (${alert.level}) ${alert.title}\n    ${alert.text.replace(/\n/g, "\n    ")}`)
      send(204, "")
    })
    return
  }
  const switchMode = /^\/mode\/(up|down|slow|leak)$/.exec(path)
  if (req.method === "POST" && switchMode) {
    mode = switchMode[1] as Mode
    log(`mode is now ${mode}`)
    return send(200, `Mode is now ${mode}.\n`)
  }
  if (req.method === "POST" && (path === "/job/stop" || path === "/job/start")) {
    jobRunning = path === "/job/start"
    log(`the job ${jobRunning ? "pings again" : "stopped pinging"}`)
    return send(200, `The job ${jobRunning ? "pings again" : "stopped pinging"}.\n`)
  }
  if (path === "/") {
    if (mode === "down") return send(503, "Service unavailable")
    if (mode === "slow") return void setTimeout(() => send(200, "Welcome to the demo shop"), 3000)
    return send(200, "Welcome to the demo shop")
  }
  if (path === "/account") {
    return mode === "leak" ? send(200, "Account balance: 1,024.00") : send(401, "Sign in to see your account.")
  }
  send(404, "Not found")
}).listen(port, () => log(`demo service on http://localhost:${port}`))

// A scheduled job that reports to its heartbeat every 30 seconds. A failed ping never stops the job.
setInterval(async () => {
  if (!jobRunning) return
  try {
    await fetch(`${belltower}/hb/${token}`)
  } catch {
    // Belltower may not be listening yet.
  }
}, 30_000)
