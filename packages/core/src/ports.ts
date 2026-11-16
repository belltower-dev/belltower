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

/** P1 is the most urgent. P5 is recorded and never sent. */
export type Priority = "P1" | "P2" | "P3" | "P4" | "P5"
export const PRIORITIES: readonly Priority[] = ["P1", "P2", "P3", "P4", "P5"]

export interface Alert {
  priority: Priority
  /** One line, for subjects and SMS. */
  title: string
  /** Plain text. A notifier that sends HTML builds it from the same content. */
  text: string
  /** Link to the incident or the acknowledge page. */
  url?: string
}

export interface Notifier {
  /** The lowest priority it sends: "P2" sends P1 and P2. */
  upTo: Priority
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

/**
 * How long each phase of an HTTP request took, in milliseconds. `firstByteMs`
 * runs from the start of the request to the response headers, so it
 * includes DNS, connect and TLS. Web-standard `fetch` can't see the first
 * three phases; only an adapter that declares `timingBreakdown` fills them.
 */
export interface HttpTiming {
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  firstByteMs?: number
  downloadMs?: number
  totalMs: number
}

/**
 * Sends a check's HTTP request. The core falls back to web-standard `fetch`
 * (`webHttpClient`); an adapter supplies its own to skip certificate
 * verification or to measure the request's phases.
 */
export interface HttpClient {
  /** Resolves when the response headers arrive. */
  fetch(
    request: Request,
    options: { verifyTls: boolean },
  ): Promise<{ response: Response; timing?: Pick<HttpTiming, "dnsMs" | "connectMs" | "tlsMs"> }>
}

export interface Clock {
  now(): Date
}

/** What an adapter can do beyond the required ports (docs/spec.md, "Capabilities"). */
export interface Capabilities {
  tlsInspector: boolean
  inbox: boolean
  sms: boolean
  /** Its HttpClient can send a request without verifying the certificate (`verifyTls: false`). */
  skipTlsVerify: boolean
  /** Its HttpClient reports DNS, connect and TLS times. */
  timingBreakdown: boolean
}
