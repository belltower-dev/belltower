import { RESULTS_FORMAT, resultsKey, type HttpClient } from "@belltower/core"
import { describe, expect, it } from "vitest"
import { createHandlers, toRequest, type FunctionUrlEvent } from "../src/index.ts"

/** A pretend AWS behind fetch: S3 objects, SSM parameters, and the SES and SNS calls it received. */
function fakeAws() {
  const objects = new Map<string, string>()
  const parameters = new Map<string, string>([["/belltower/NIGHTLY_TOKEN", "n1ghtly"]])
  const emails: Record<string, unknown>[] = []
  const texts: URLSearchParams[] = []
  const services: string[] = []

  const handler: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const service = /Credential=[^/]+\/\d{8}\/[^/]+\/([^/]+)\//.exec(headers.get("authorization") ?? "")?.[1]
    if (!service) return new Response("unsigned", { status: 403 })
    services.push(service)
    const body = String(init?.body ?? "")

    if (url.hostname.startsWith("ssm.")) {
      const name = (JSON.parse(body) as { Name: string }).Name
      const value = parameters.get(name)
      if (value === undefined) return Response.json({ __type: "com.amazonaws.ssm#ParameterNotFound", message: "not found" }, { status: 400 })
      return Response.json({ Parameter: { Name: name, Value: value } })
    }
    if (url.hostname.startsWith("email.")) {
      emails.push(JSON.parse(body) as Record<string, unknown>)
      return Response.json({ MessageId: "m-1" })
    }
    if (url.hostname.startsWith("sns.")) {
      texts.push(new URLSearchParams(body))
      return new Response("<PublishResponse><PublishResult><MessageId>s-1</MessageId></PublishResult></PublishResponse>")
    }
    // S3, virtual-host style: {bucket}.s3.{region}.amazonaws.com/{key}
    const key = decodeURIComponent(url.pathname.slice(1))
    if (init?.method === "PUT") {
      objects.set(key, body)
      return new Response(null, { status: 200 })
    }
    if (url.searchParams.get("list-type") === "2") {
      const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort()
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`)
    }
    const value = objects.get(key)
    return value === undefined ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : new Response(value)
  }
  return { handler, objects, emails, texts, services }
}

const config = {
  components: [{ name: "Website" }, { name: "Jobs", critical: true }],
  notifiers: [
    { id: "ops", type: "email", to: ["ops@example.com"] },
    { id: "pager", type: "sms", to: ["+15555550100"] },
  ],
  checks: [
    { id: "home", type: "http", component: "Website", url: "https://www.example.com/" },
    { id: "nightly", type: "heartbeat", component: "Jobs", period: "1d", token: "NIGHTLY_TOKEN", public: false },
  ],
}

const env = {
  BELLTOWER_REGIONS: "us-east-1,eu-west-1",
  AWS_REGION: "us-east-1",
  BELLTOWER_BUCKET: "belltower-demo",
  BELLTOWER_SSM_PREFIX: "/belltower/",
  BELLTOWER_EMAIL_FROM: "alerts@example.com",
  AWS_ACCESS_KEY_ID: "ASIATEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_SESSION_TOKEN: "session",
}

const okHttp: HttpClient = { fetch: async () => ({ response: new Response("Welcome") }) }

function setup(now = "2026-11-15T10:00:05Z", http = okHttp) {
  const aws = fakeAws()
  let t = Date.parse(now)
  const logs: Record<string, unknown>[] = []
  const handlers = createHandlers(config, { env, fetch: aws.handler, http, now: () => new Date(t), log: (e) => logs.push(e) })
  return { aws, handlers, logs, advance: (ms: number) => (t += ms) }
}

const ping = (path: string): FunctionUrlEvent => ({ rawPath: path, requestContext: { domainName: "abc.lambda-url.us-east-1.on.aws", http: { method: "GET" } } })

describe("createHandlers", () => {
  it("runs the region's checks and writes results to S3", async () => {
    const { handlers, aws, logs } = setup()
    expect(await handlers.checks()).toEqual({ region: "us-east-1", checks: 1, failed: 0 })
    expect([...aws.objects.keys()]).toEqual(["results/us-east-1/2026/11/15/1000.json"])
    expect(logs[0]).toMatchObject({ event: "checks", region: "us-east-1" })
    expect(aws.services).toContain("s3")
  })

  it("records a heartbeat through the function URL, reading its token from SSM", async () => {
    const { handlers, aws } = setup()
    const result = await handlers.http(ping("/hb/n1ghtly"))
    expect(result).toMatchObject({ statusCode: 200, body: "Recorded a success for nightly.", isBase64Encoded: false })
    expect(aws.objects.has("heartbeats/nightly.json")).toBe(true)
    expect(aws.services).toContain("ssm")
    expect((await handlers.http(ping("/hb/wrong"))).statusCode).toBe(404)
  })

  it("emails through SES and texts through SNS when a critical heartbeat fails", async () => {
    const { handlers, aws } = setup()
    await handlers.http(ping("/hb/n1ghtly/fail"))
    const report = await handlers.decide()
    expect(report.opened).toEqual(["nightly-202611151000"])
    expect(aws.emails).toEqual([
      expect.objectContaining({
        FromEmailAddress: "alerts@example.com",
        Destination: { ToAddresses: ["ops@example.com"] },
        Content: { Simple: expect.objectContaining({ Subject: { Data: "Down: nightly (Jobs)", Charset: "UTF-8" } }) },
      }),
    ])
    expect(aws.texts).toHaveLength(1)
    expect(aws.texts[0]?.get("Action")).toBe("Publish")
    expect(aws.texts[0]?.get("PhoneNumber")).toBe("+15555550100")
    expect(aws.texts[0]?.get("Message")).toContain("Down: nightly (Jobs)")
    expect(aws.services).toEqual(expect.arrayContaining(["ses", "sns"]))
  })

  it("opens an HTTP incident from both regions' results in S3", async () => {
    const { handlers, aws } = setup("2026-11-15T10:02:30Z")
    for (const at of ["2026-11-15T10:00:00Z", "2026-11-15T10:01:00Z"]) {
      for (const region of ["us-east-1", "eu-west-1"]) {
        const minute = new Date(at)
        aws.objects.set(
          resultsKey(region, minute),
          JSON.stringify({ format: RESULTS_FORMAT, region, startedAt: at, finishedAt: at, results: [{ id: "home", ok: false, slow: false, failure: "status", message: "Got status 503, expected 2xx.", status: 503, timing: { totalMs: 9 } }] }),
        )
      }
    }
    expect((await handlers.decide()).opened).toEqual(["home-202611151000"])
    expect(aws.emails).toHaveLength(1)
    expect(aws.texts).toHaveLength(0)
    expect(JSON.parse(aws.objects.get("public/status.json") ?? "").overall).toBe("down")
  })

  it("refuses to start with every missing setting listed", async () => {
    const handlers = createHandlers(config, { env: {}, log: () => {} })
    await expect(handlers.checks()).rejects.toThrow(/BELLTOWER_REGIONS isn't set[\s\S]*BELLTOWER_BUCKET isn't set[\s\S]*AWS_ACCESS_KEY_ID/)
  })

  it("refuses a config error at start, with the field", async () => {
    const handlers = createHandlers({ ...config, checks: [{ id: "home", type: "http", component: "Website" }] }, { env, log: () => {} })
    await expect(handlers.checks()).rejects.toThrow("checks[0] (home).url: is required")
  })
})

describe("toRequest", () => {
  it("rebuilds the URL, query and body from a function URL event", async () => {
    const request = toRequest({
      rawPath: "/hb/abc",
      rawQueryString: "run=r1",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hello").toString("base64"),
      isBase64Encoded: true,
      requestContext: { domainName: "abc.lambda-url.us-east-1.on.aws", http: { method: "POST" } },
    })
    expect(request.url).toBe("https://abc.lambda-url.us-east-1.on.aws/hb/abc?run=r1")
    expect(await request.text()).toBe("hello")
  })
})
