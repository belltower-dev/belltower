// The HTTP client alone, so the Lambda bundle leaves out the container's SMTP and server code.
import { nodeHttpClient } from "@belltower/adapter-container/node-http-client"
import {
  buildNotifiers,
  decide,
  handle,
  runChecks,
  s3Store,
  validateConfig,
  type Capabilities,
  type Config,
  type HttpClient,
  type Notifier,
  type Secrets,
  type Store,
} from "@belltower/core"
import { credentialsFromEnv, sesNotifier, snsNotifier, ssmSecrets, type AwsContext } from "./aws.ts"

/*
 * Lambda handlers for the three entry points. A deployment's own handler
 * file imports its config and calls createHandlers:
 *
 *   import config from "./belltower.config.json" with { type: "json" }
 *   export const { checks, decide, http } = createHandlers(config)
 *
 * Settings come from the function's environment:
 *
 *   BELLTOWER_REGIONS        every region the deployment runs in, such as us-east-1,eu-west-1
 *   BELLTOWER_REGION         this function's region name (default: AWS_REGION)
 *   BELLTOWER_BUCKET         the S3 bucket all regions share
 *   BELLTOWER_BUCKET_REGION  the bucket's region (default: AWS_REGION)
 *   BELLTOWER_BUCKET_PREFIX  optional key prefix in the bucket
 *   BELLTOWER_SSM_PREFIX     optional SSM Parameter Store path for secrets, such as /belltower/
 *   BELLTOWER_EMAIL_FROM     the verified SES sender, if any notifier sends email
 */

/** What a Lambda region can do. The TLS inspector arrives with certificate checks. */
export const AWS_CAPABILITIES: Capabilities = {
  tlsInspector: false,
  inbox: false,
  sms: true,
  skipTlsVerify: true,
  timingBreakdown: true,
}

export interface HandlerOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  http?: HttpClient
  now?: () => Date
  log?: (entry: Record<string, unknown>) => void
}

/** The parts of a Lambda function URL event (payload format 2.0) Belltower reads. */
export interface FunctionUrlEvent {
  rawPath: string
  rawQueryString?: string
  headers?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
  requestContext: { domainName: string; http: { method: string } }
}

export interface FunctionUrlResult {
  statusCode: number
  headers: Record<string, string>
  body: string
  isBase64Encoded: boolean
}

interface Runtime {
  config: Config
  byRegion: Record<string, string[]>
  region: string
  store: Store
  secrets: Secrets
  aws: AwsContext
}

export function createHandlers(rawConfig: unknown, options: HandlerOptions = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const clock = { now: options.now ?? (() => new Date()) }
  let runtime: Runtime | null = null

  /** Builds everything once per cold start, and fails with every problem at once. */
  function setup(): Runtime {
    if (runtime) return runtime
    const problems: string[] = []
    const need = (name: string) => {
      const value = env[name]
      if (!value) problems.push(`${name} isn't set.`)
      return value ?? ""
    }
    const regionNames = need("BELLTOWER_REGIONS").split(",").map((s) => s.trim()).filter(Boolean)
    const region = env.BELLTOWER_REGION ?? env.AWS_REGION ?? ""
    if (!region) problems.push("Neither BELLTOWER_REGION nor AWS_REGION is set.")
    const bucket = need("BELLTOWER_BUCKET")
    const credentials = credentialsFromEnv(env)
    if (!credentials) problems.push("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY aren't set; Lambda sets them from the function's role.")
    if (region && regionNames.length && !regionNames.includes(region)) problems.push(`This region, ${region}, isn't in BELLTOWER_REGIONS (${regionNames.join(", ")}).`)

    const result = validateConfig(rawConfig, regionNames.map((name) => ({ name, capabilities: AWS_CAPABILITIES })))
    if (!result.ok) problems.push(...result.errors)
    if (problems.length || !result.ok || !credentials) throw new Error(`Belltower can't start:\n- ${problems.join("\n- ")}`)

    const aws: AwsContext = { region, credentials, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) }
    const store = s3Store({
      endpoint: env.BELLTOWER_S3_ENDPOINT ?? `https://s3.${env.BELLTOWER_BUCKET_REGION ?? region}.amazonaws.com`,
      bucket,
      region: env.BELLTOWER_BUCKET_REGION ?? region,
      credentials,
      ...(env.BELLTOWER_BUCKET_PREFIX ? { prefix: env.BELLTOWER_BUCKET_PREFIX } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    runtime = { config: result.config, byRegion: result.byRegion, region, store, secrets: ssmSecrets(aws, env, env.BELLTOWER_SSM_PREFIX), aws }
    return runtime
  }

  function notifiers(rt: Runtime): Notifier[] {
    const from = env.BELLTOWER_EMAIL_FROM
    if (!from && rt.config.notifiers.some((n) => n.type === "email")) {
      throw new Error("Belltower can't send email: BELLTOWER_EMAIL_FROM isn't set. Set it to a sender address verified in SES.")
    }
    return buildNotifiers(rt.config.notifiers, {
      secrets: rt.secrets,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      others: {
        email: (c) => sesNotifier(c as Extract<typeof c, { type: "email" }>, rt.aws, from ?? ""),
        sms: (c) => snsNotifier(c as Extract<typeof c, { type: "sms" }>, rt.aws),
      },
    })
  }

  return {
    /** Scheduled every minute in every region. */
    async checks(): Promise<{ region: string; checks: number; failed: number }> {
      const rt = setup()
      const file = await runChecks(rt.region, { ...rt, clock, http: options.http ?? nodeHttpClient() })
      const failed = file.results.filter((r) => !r.ok)
      log({ event: "checks", region: rt.region, checks: file.results.length, failed: failed.map((r) => ({ id: r.id, failure: r.failure, message: r.message })) })
      return { region: rt.region, checks: file.results.length, failed: failed.length }
    },

    /** Scheduled every minute in one region. */
    async decide(): Promise<{ opened: string[]; resolved: string[]; problems: string[] }> {
      const rt = setup()
      const report = await decide({ ...rt, clock, notifiers: notifiers(rt) })
      log({ event: "decide", states: report.states, opened: report.opened.map((i) => i.id), resolved: report.resolved.map((i) => i.id), problems: report.problems })
      return { opened: report.opened.map((i) => i.id), resolved: report.resolved.map((i) => i.id), problems: report.problems }
    },

    /** Behind a function URL: heartbeat pings. */
    async http(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
      const rt = setup()
      const response = await handle(toRequest(event), { ...rt, clock })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => (headers[name] = value))
      return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false }
    },
  }
}

export function toRequest(event: FunctionUrlEvent): Request {
  const method = event.requestContext.http.method
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value)
  const hasBody = event.body !== undefined && method !== "GET" && method !== "HEAD"
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : event.body) : undefined
  return new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) })
}
