import { sha256Hex, signRequest, type AwsCredentials, type Notifier, type NotifierConfig, type Secrets } from "@belltower/core"

/*
 * The AWS services Belltower calls, over fetch with the core's SigV4
 * signer: SSM Parameter Store for secrets, SES for email, SNS for SMS. No
 * AWS SDK, so the Lambda package stays small.
 */

export interface AwsContext {
  region: string
  credentials: AwsCredentials
  fetch?: typeof fetch
  now?: () => Date
}

/** The credentials Lambda puts in every function's environment. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): AwsCredentials | null {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  }
}

/** One signed call. Throws with the service's own error code and message on failure. */
export async function awsCall(ctx: AwsContext, service: string, host: string, init: { method: string; path?: string; headers?: Record<string, string>; body: string }): Promise<string> {
  const url = new URL(`https://${host}${init.path ?? "/"}`)
  const headers = await signRequest({
    method: init.method,
    url,
    headers: init.headers ?? {},
    payloadHash: await sha256Hex(init.body),
    region: ctx.region,
    service,
    credentials: ctx.credentials,
    date: (ctx.now ?? (() => new Date()))(),
  })
  const doFetch = ctx.fetch ?? ((input, i) => fetch(input, i))
  const response = await doFetch(url, { method: init.method, headers, body: init.body, signal: AbortSignal.timeout(15_000) })
  const text = await response.text()
  if (!response.ok) {
    let code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    let message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
    try {
      const json = JSON.parse(text) as { __type?: string; message?: string; Message?: string }
      code = json.__type?.split("#").pop() ?? code
      message = json.message ?? json.Message ?? message
    } catch {
      // Not JSON; the XML fields above apply.
    }
    throw new Error(`${service} answered ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`)
  }
  return text
}

/**
 * Secrets from environment variables first, then SSM Parameter Store under a
 * prefix (BELLTOWER_SSM_PREFIX, such as /belltower/). Values are cached for
 * five minutes, so a warm function doesn't call SSM on every run.
 */
export function ssmSecrets(ctx: AwsContext, env: NodeJS.ProcessEnv, prefix: string | undefined): Secrets {
  const cache = new Map<string, { value: string | null; until: number }>()
  return {
    async get(name) {
      const fromEnv = env[name]
      if (fromEnv !== undefined) return fromEnv
      if (!prefix) return null
      const now = Date.now()
      const hit = cache.get(name)
      if (hit && hit.until > now) return hit.value
      let value: string | null = null
      try {
        const text = await awsCall(ctx, "ssm", `ssm.${ctx.region}.amazonaws.com`, {
          method: "POST",
          headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameter" },
          body: JSON.stringify({ Name: `${prefix.replace(/\/*$/, "/")}${name}`, WithDecryption: true }),
        })
        value = (JSON.parse(text) as { Parameter?: { Value?: string } }).Parameter?.Value ?? null
      } catch (error) {
        if (!/ParameterNotFound/.test((error as Error).message)) throw error
      }
      cache.set(name, { value, until: now + 5 * 60_000 })
      return value
    },
  }
}

/** Sends alert email through SES. The sender must be a verified SES identity. */
export function sesNotifier(config: Extract<NotifierConfig, { type: "email" }>, ctx: AwsContext, from: string): Notifier {
  return {
    upTo: config.upTo,
    async send(alert) {
      try {
        await awsCall(ctx, "ses", `email.${ctx.region}.amazonaws.com`, {
          method: "POST",
          path: "/v2/email/outbound-emails",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            FromEmailAddress: from,
            Destination: { ToAddresses: [...config.to] },
            Content: {
              Simple: {
                Subject: { Data: alert.title, Charset: "UTF-8" },
                Body: { Text: { Data: alert.url ? `${alert.text}\n\n${alert.url}` : alert.text, Charset: "UTF-8" } },
              },
            },
          }),
        })
      } catch (error) {
        throw new Error(`Notifier "${config.id}" couldn't send email through SES: ${(error as Error).message}`)
      }
    },
  }
}

/** Sends alerts by SMS through SNS, one message per number, as transactional messages. */
export function snsNotifier(config: Extract<NotifierConfig, { type: "sms" }>, ctx: AwsContext): Notifier {
  return {
    upTo: config.upTo,
    async send(alert) {
      // An SMS is short, so it carries the title and the first line of the text.
      const message = `${alert.title}\n${alert.text.split("\n")[0] ?? ""}`.slice(0, 600)
      const failures: string[] = []
      await Promise.all(
        config.to.map(async (number) => {
          const body = new URLSearchParams({
            Action: "Publish",
            Version: "2010-03-31",
            PhoneNumber: number,
            Message: message,
            "MessageAttributes.entry.1.Name": "AWS.SNS.SMS.SMSType",
            "MessageAttributes.entry.1.Value.DataType": "String",
            "MessageAttributes.entry.1.Value.StringValue": "Transactional",
          }).toString()
          try {
            await awsCall(ctx, "sns", `sns.${ctx.region}.amazonaws.com`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
              body,
            })
          } catch (error) {
            failures.push((error as Error).message)
          }
        }),
      )
      if (failures.length) throw new Error(`Notifier "${config.id}" couldn't send ${failures.length} of ${config.to.length} texts through SNS: ${failures[0]}`)
    },
  }
}
