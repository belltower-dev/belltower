/*
 * What a platform adapter supplies to the core (docs/spec.md, "What the
 * platform supplies"). The core only talks to these; it never imports a cloud
 * SDK or a Node built-in.
 */

/** Object storage reachable from every region, with read-after-write consistency. */
export interface Store {
  /** The object's text, or null when there is none. */
  get(key: string): Promise<string | null>
  put(key: string, body: string, options?: { contentType?: string }): Promise<void>
  /** Keys under a prefix, in lexical order. */
  list(prefix: string): Promise<string[]>
}

export type AlertLevel = "info" | "warn" | "alert" | "critical"

export interface Alert {
  level: AlertLevel
  /** One line, for subjects and SMS. */
  title: string
  /** Plain text. A notifier that sends HTML builds it from the same content. */
  text: string
  /** Link to the incident or the acknowledge page. */
  url?: string
}

export interface Notifier {
  /** Which levels this notifier sends; SMS notifiers usually take only "critical". */
  levels: readonly AlertLevel[]
  send(alert: Alert): Promise<void>
}

export interface Secrets {
  /** The secret's value, or null when it isn't set. */
  get(name: string): Promise<string | null>
}

/** Reads the email round trip's mailbox (docs/spec.md, "Email round trip"). */
export interface Inbox {
  /** Whether a message carrying this run ID has arrived. */
  find(runId: string): Promise<{ receivedAt: Date } | null>
}

/** What one TLS handshake revealed (docs/certificates.md). */
export interface CertificateInspection {
  address: string
  notBefore: Date
  notAfter: Date
  subjectAltNames: string[]
  issuer: string
  fingerprint256: string
  /** Whether the chain verified against the runtime's root store. */
  trusted: boolean
  trustError: string | null
}

/** Reads a server's certificate. Only on runtimes that can (docs/certificates.md). */
export interface TlsInspector {
  inspect(target: { host: string; port: number; servername: string; address?: string }): Promise<CertificateInspection>
}

export interface Clock {
  now(): Date
}

/** What an adapter can do beyond the required ports (docs/spec.md, "Capabilities"). */
export interface Capabilities {
  tlsInspector: boolean
  inbox: boolean
  sms: boolean
}
