import type { NotifierConfig } from "./config.ts"
import type { Alert, Notifier, Secrets } from "./ports.ts"

/*
 * Notifiers the core can build with web-standard APIs alone. Adapters build
 * the rest (email and SMS) and call `buildNotifiers` with them.
 */

export const ALERT_FORMAT = "belltower.alert/1"

/** The JSON a webhook receives. Versioned by `format`; fields are only added within a version. */
export interface WebhookPayload {
  format: typeof ALERT_FORMAT
  level: Alert["level"]
  title: string
  text: string
  url?: string
}

/** POSTs each alert as JSON to the URL held in a secret, read when the alert is sent. */
export function webhookNotifier(
  config: Extract<NotifierConfig, { type: "webhook" }>,
  secrets: Secrets,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Notifier {
  return {
    levels: config.levels,
    async send(alert) {
      const url = await secrets.get(config.secret)
      if (!url) throw new Error(`The secret "${config.secret}" for notifier "${config.id}" isn't set. Set it to the webhook URL.`)
      const payload: WebhookPayload = { format: ALERT_FORMAT, ...alert }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Notifier "${config.id}": the webhook answered ${response.status}.`)
    },
  }
}

export type NotifierFactory = (config: NotifierConfig) => Notifier

/**
 * Builds a Notifier for each configured notifier. `others` supplies the
 * types the adapter handles (email, sms); a type with no factory is an
 * error that names the notifier, raised before anything runs.
 */
export function buildNotifiers(
  configs: readonly NotifierConfig[],
  deps: { secrets: Secrets; fetch?: typeof fetch; others?: Partial<Record<"email" | "sms", NotifierFactory>> },
): Notifier[] {
  return configs.map((config) => {
    if (config.type === "webhook") return webhookNotifier(config, deps.secrets, deps.fetch)
    const factory = deps.others?.[config.type]
    if (!factory) throw new Error(`Notifier "${config.id}" is type ${config.type}, which this adapter can't send yet. Use a webhook notifier, or run decide() on an adapter that sends ${config.type}.`)
    return factory(config)
  })
}
