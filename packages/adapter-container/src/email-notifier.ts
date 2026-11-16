import { createTransport } from "nodemailer"
import type { Alert, Notifier, NotifierConfig, Secrets } from "@belltower/core"

/*
 * Sends alerts by SMTP. The connection and the sender come from two
 * secrets, so no address or password sits in the config:
 *
 *   BELLTOWER_SMTP_URL    smtp://user:password@smtp.example.com:587
 *                         (smtps:// for port 465)
 *   BELLTOWER_EMAIL_FROM  Belltower <alerts@example.com>
 *
 * Alerts go out as plain text, which every mail client and screen reader
 * handles. An HTML part comes with the alert email design.
 */

export const SMTP_URL_SECRET = "BELLTOWER_SMTP_URL"
export const EMAIL_FROM_SECRET = "BELLTOWER_EMAIL_FROM"

export interface SmtpSettings {
  url: string
  from: string
}

/** Reads the SMTP settings, or says which secrets are missing. */
export async function smtpSettings(secrets: Secrets): Promise<SmtpSettings | { missing: string[] }> {
  const [url, from] = await Promise.all([secrets.get(SMTP_URL_SECRET), secrets.get(EMAIL_FROM_SECRET)])
  const missing = [...(url ? [] : [SMTP_URL_SECRET]), ...(from ? [] : [EMAIL_FROM_SECRET])]
  return url && from ? { url, from } : { missing }
}

export function emailNotifier(config: Extract<NotifierConfig, { type: "email" }>, settings: SmtpSettings): Notifier {
  const transport = createTransport(settings.url)
  return {
    upTo: config.upTo,
    async send(alert: Alert) {
      try {
        await transport.sendMail({
          from: settings.from,
          to: [...config.to],
          subject: alert.title,
          text: alert.url ? `${alert.text}\n\n${alert.url}` : alert.text,
          signal: AbortSignal.timeout(30_000),
        })
      } catch (error) {
        throw new Error(`Notifier "${config.id}" couldn't send email: ${(error as Error).message}`)
      }
    },
  }
}
