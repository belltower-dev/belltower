# Belltower: certificate and domain checks

How Belltower checks TLS certificates and domain registrations, and how to
get these checks working on each platform. Part of the
[specification](spec.md).

An expired certificate takes a site down as completely as a server outage,
and a lapsed domain is worse. Both are announced weeks ahead, so a monitor
that misses them has no excuse. These checks give that warning.

## Why the expiry rule isn't a fixed number of days

Certificate lifetimes are shrinking. Under CA/Browser Forum ballot SC-081
(passed April 2025), the longest a public TLS certificate may be valid is:

| From | Maximum validity |
| --- | --- |
| 15 March 2026 | 200 days |
| 15 March 2027 | 100 days |
| 15 March 2029 | 47 days |

Let's Encrypt certificates are already 90 days. Automated clients (ACME)
renew when about a third of the lifetime remains. So:

- A fixed "warn at 30 days" fires on every healthy 47-day certificate.
- A fixed "warn at 7 days" gives a 200-day certificate's owner almost no time.

The monitor uses both a fraction of each certificate's lifetime and a floor
in days. Whichever is reached first applies.

## Certificate check

### What one check inspects

| Field | Meaning | Default |
| --- | --- | --- |
| `host` | Name to connect to | required |
| `port` | | 443 |
| `servername` | Name sent in SNI, which picks the certificate on shared hosts | `host` |
| `addresses` | `first` (whatever DNS returns first) or `all` (every A and AAAA record, checked separately) | `first` |
| `renewWithin` | Warn when less than this fraction of the lifetime remains: renewal should have happened | `1/3` |
| `warnDays` | Warn when fewer days remain, whatever the lifetime | 14 |
| `alertDays` | Alert when fewer days remain | 7 |
| `regions` | Which regions may run it (one must support the TLS inspector); it runs in the first that does | all |
| `schedule` | How often | daily |

Use `addresses: all` behind load balancers or several origins. Each address
can serve a different certificate, and one stale node is how certificate
outages usually start.

### Findings

Each inspection records, per address:

| Finding | Level | Rule |
| --- | --- | --- |
| Expired | Alert | `notAfter` is in the past |
| Not yet valid | Alert | `notBefore` is in the future |
| Untrusted chain | Alert | Doesn't verify against the runtime's root store (self-signed, unknown CA, missing intermediate) |
| Wrong name | Alert | No subject alternative name matches `servername` |
| Expiring | Alert | Fewer than `alertDays` days left |
| Renewal overdue | Warn | Less than `renewWithin` of the lifetime left, or fewer than `warnDays` days |
| Changed | Info | Fingerprint differs from the last inspection. Recorded on the incident timeline; issuer changes are called out |
| Unreachable | Unknown | No TLS connection after one retry. Not a certificate finding: reachability belongs to the HTTP checks |

Alert and Warn open an incident on the check like any other failure. Info
only records. Unknown records and, after three days in a row, warns that the
check isn't running.

### Stored per inspection

`host`, `port`, `servername`, address, time, `notBefore`, `notAfter`, days
left, lifetime in days, fraction left, subject alternative names, issuer,
SHA-256 fingerprint, whether the chain verified and why not, findings.

## How to inspect a certificate on each platform

The core never opens sockets. The TLS inspector is an optional port that an
adapter supplies when its runtime can read the certificate from a handshake.

### Node runtimes: Lambda, containers, Cloud Run, Knative, Kubernetes, Fly

Node's `tls` module gives everything needed. Connect with verification off,
so an expired or untrusted certificate can still be read, then report
whether it would have verified:

```ts
import { connect } from "node:tls"

export function inspect(host: string, port: number, servername: string, address?: string) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address ?? host, port, servername, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate(true)
      resolve({
        notBefore: new Date(cert.valid_from),
        notAfter: new Date(cert.valid_to),
        subjectAltNames: cert.subjectaltname,
        issuer: cert.issuer,
        fingerprint256: cert.fingerprint256,
        trusted: socket.authorized,
        trustError: socket.authorizationError ?? null,
      })
      socket.end()
    })
    socket.on("timeout", () => socket.destroy(new Error("timeout")))
    socket.on("error", reject)
  })
}
```

- `rejectUnauthorized: false` is what lets the check report an expired or
  self-signed certificate instead of failing to connect. Never reuse that
  socket for anything else.
- Check the name against `servername` with `tls.checkServerIdentity`, since
  verification is off.
- For `addresses: all`, resolve with `node:dns` (`resolve4`, `resolve6`) and
  connect to each address with the same `servername`.
- Lambda's Node runtimes, the container image and every Node host support
  this without extra setup.

### Cloudflare Workers

Workers' `fetch` and `cloudflare:sockets` don't expose the server's
certificate. With the `nodejs_compat` flag, Workers provides parts of
`node:tls` (`connect`, `TLSSocket`, `checkServerIdentity`), but whether
`getPeerCertificate` returns the certificate's fields isn't documented as of
November 2026.

So the Cloudflare adapter probes at startup: it connects to a known host and
enables the TLS inspector only if `getPeerCertificate()` returns a
`valid_to`. If the probe fails, the adapter declares no TLS inspector, and a
deployment that's entirely on Workers needs one of these:

1. **A Node region for certificates (recommended).** Add one small region on
   any Node adapter, such as a Lambda or a Cloud Run job once a day, assigned
   only the `tls` checks. The cost is effectively nothing, and the check is
   the real one. The deploy check suggests this first.
2. **Certificate Transparency, as a weaker substitute.** Every public
   certificate is logged. A CT search API (crt.sh, or SSLMate's Cert Spotter
   API, which has a free tier) returns the certificates issued for a name.
   The check takes the latest `notAfter` among unexpired certificates that
   cover the name.
   - It shows what was issued, not what's served. A certificate renewed but
     never deployed looks healthy. Results are labeled "issued, not checked
     on the server".
   - It can't check the chain, the name match or individual addresses.
   - Rate limits and outages on the public services make it unsuitable
     every minute; once a day is fine.
3. **The platform's own API.** When the certificates are managed by a
   platform (Cloudflare's SSL/TLS, AWS Certificate Manager, Google-managed
   certificates), its API reports their expiry. This is an optional plugin
   per platform, not part of the core.

Parsing a TLS handshake by hand over a raw socket is not an option: TLS 1.3
encrypts the certificate message, and many servers accept nothing older.

### Other runtimes

Deno and Bun implement `node:tls`, and the Node approach may work there
unchanged. Treat it as untested until the adapter's startup probe passes;
the probe decides, not the runtime's name.

## Domain registration check

Uses RDAP, the successor to WHOIS, over plain HTTPS, so it runs on every
platform including Workers.

### How

1. Fetch IANA's bootstrap file, `https://data.iana.org/rdap/dns.json`, at
   most once a day. It maps each top-level domain to its RDAP servers.
2. Take the registrable domain (`example.co.uk`, not `www.example.co.uk`;
   use the Public Suffix List).
3. `GET {server}domain/{name}` with `Accept: application/rdap+json`.
4. Read the `events` array: the entry with `eventAction: "expiration"` gives
   the date.
5. Follow a `related` link to the registrar's RDAP server if the registry's
   answer has no expiration event.

### Defaults

| Field | Default |
| --- | --- |
| `warnDays` | 30 |
| `alertDays` | 14 |
| `schedule` | daily |

Also recorded: registrar, status codes (`clientHold` or `serverHold` mean the
domain doesn't resolve; alert on either), and nameservers (an unexpected
change is an Info finding).

### When RDAP has no answer

Some country-code domains have no RDAP server, or don't publish the
expiration date. The check then reports **Unsupported** with the reason and
never fails silently.

- WHOIS over TCP port 43 could fill the gap, but every registry formats it
  differently. It isn't in the core.
- For those domains: set a calendar reminder from the registrar's renewal
  date, and turn on auto-renew.

## Testing these checks

Public test hosts from badssl.com give every failure on demand:

| Host | Expect |
| --- | --- |
| `expired.badssl.com` | Expired |
| `wrong.host.badssl.com` | Wrong name |
| `self-signed.badssl.com` | Untrusted chain |
| `untrusted-root.badssl.com` | Untrusted chain |
| `badssl.com` | No findings |

- The core's tests run the rules on recorded inspections, with time passed
  in, including certificates with 47-, 90- and 200-day lifetimes.
- Each adapter's contract tests run a real inspection against the hosts
  above, so a runtime change that breaks `getPeerCertificate` fails CI.
- Domain checks are tested on recorded RDAP responses, including one with no
  expiration event and one top-level domain missing from the bootstrap file.

## Configuration example

```ts
checks: [
  { id: "tls-www", type: "tls", component: "Website", host: "www.example.com", addresses: "all", public: false },
  { id: "tls-api", type: "tls", component: "API", host: "api.example.com", public: false },
  { id: "domain", type: "domain", component: "Website", domain: "example.com", public: false },
]
```
