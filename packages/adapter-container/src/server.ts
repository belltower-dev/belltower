import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

/*
 * Serves a fetch handler, such as the core's handle(), over node:http.
 * GET /healthz answers 200 for the platform's health checks.
 */

const MAX_BODY = 64 * 1024

export function serveFetch(handler: (request: Request) => Promise<Response>, onError: (error: unknown) => void = () => {}): Server {
  return createServer((req, res) => {
    respond(req, res, handler).catch((error: unknown) => {
      onError(error)
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Belltower hit an error answering this request. The server log has the details.")
    })
  })
}

async function respond(req: IncomingMessage, res: ServerResponse, handler: (request: Request) => Promise<Response>) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("ok")
    return
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) {
      res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" }).end("The request body is larger than 64 KB. Heartbeats need no body.")
      return
    }
    chunks.push(chunk as Buffer)
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else if (value !== undefined) headers.set(name, value)
  }
  const method = req.method ?? "GET"
  const request = new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) })

  const response = await handler(request)
  const out: Record<string, string> = {}
  response.headers.forEach((value, name) => (out[name] = value))
  res.writeHead(response.status, out)
  res.end(method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()))
}
