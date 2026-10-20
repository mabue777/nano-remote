# Security pass: Nano Host v0 (before the Phase 1 acceptance run)

Operator todo item 10; protocol-v1.md section 8 hands this pass code lifetime, token storage and
tailnet-only binding. Date: 2026-10-20. Scope: `host/src/pairing`, `host/src/devices`, `host/src/stream`
(upgrade authentication), `host/src/http`, `host/src/cli` (control channel, config, logs, launchd),
`host/src/journal` (file creation), and the new `host/src/push/vapid.ts`.

Test names below are vitest names (`file > describe > it`). All run in `pnpm -C host verify`, which the
gate (`scripts/verify.sh`) runs.

## Summary

| # | Item | Status | Changed in this pass |
|---|---|---|---|
| 1 | Pairing code | Pass | none (one accepted risk) |
| 2 | Device token | Pass after fix | Origin check, bearer refused from browser pages, crash on a malformed cookie fixed |
| 3 | Revocation | Pass | none |
| 4 | Binding and TLS | Pass after fix | certificate and key tightened to 0600 at startup and after `nano-host cert` |
| 5 | Files | Pass after fix | Journal/device database and its WAL files 0600; NanoHost folder forced 0700 on every start; launchd output files 0600 |
| 6 | Web Push preparation | Pass after fix | VAPID key pair generated, stored 0600, advertised in `initialize`; table designed below |
| 7 | Logs | Pass after fix | unparsable Codex output no longer logged as text; end-to-end log test added |
| 8 | Dependencies | Pass | `pnpm audit`: no known vulnerabilities |
| 9 | Control channel | Pass | none |

## 1. Pairing code: Pass

- 8 digits from `crypto.randomInt`, 5-minute lifetime, single use, at most 16 outstanding codes.
  Test: `src/pairing/codes.test.ts > pairing codes > issues 8-digit codes with a 5-minute lifetime and the QR URL`,
  `> redeems a code once`, `> refuses an expired code`, `> keeps at most MAX_OUTSTANDING_CODES and never issues a duplicate`;
  over HTTP: `src/http/server.test.ts > pairing over HTTP > refuses an expired code`, `> refuses a reused code`.
- Constant-time comparison: `PairingCodes.match` compares the candidate with every outstanding code using
  `timingSafeEqual`, without stopping early; malformed candidates are refused before comparison so the
  lengths always match. Evidence: code review (timing is not measurable in a unit test) plus
  `src/pairing/codes.test.ts > pairing codes > refuses wrong and malformed codes`.
- Failure rate limit: 5 failures per minute per remote address, then 429 `rate_limited` with
  `retryAfterMs` and `Retry-After`, even for the right code. Tests:
  `src/pairing/codes.test.ts > pairing codes > rate limits a source after 5 failures per minute, even for the right code`,
  `src/http/server.test.ts > pairing over HTTP > refuses wrong codes and rate limits the source after 5 failures`.
- Code never logged: the control channel logs only `expiresAt`; the pairing endpoint logs only the clientId.
  The code travels in the URL fragment (`/pair#code=`), which browsers never send to the server.
  Test: `src/cli/service.test.ts > host service > security: no token, code, cookie or session content in the log; private files; VAPID key in initialize`
  (a wrong code and the real code are both absent from `host.log` and stdout).

Accepted risk: the rate limit is per source address, not global. A tailnet peer has one IPv4 and one IPv6
address, so it gets 10 guesses a minute: about 50 per 5-minute code lifetime against 10^8 codes, with at
most 16 outstanding, a chance below 1 in 100 000 even with every slot filled. Only tailnet members can
reach the endpoint at all (item 4). A global limit would let one peer lock out pairing for everyone, so it
is not added.

Accepted risk: `nano-host pair` prints the code and its QR in the operator's own terminal. That is the
purpose of the command; the code is not written to any log.

## 2. Device token: Pass after fix

- 256 bits from `node:crypto` `randomBytes(32)`, base64url; only the SHA-256 hex is stored, lookup is by
  hash. Tests: `src/devices/store.test.ts > device store > creates a dev_ device with a 256-bit base64url token and authenticates it`,
  `> stores only the SHA-256 of the token`.
- Cookie `nano_device` with `HttpOnly; Secure; SameSite=Strict; Path=/` and no `Domain`. Test:
  `src/http/server.test.ts > pairing over HTTP > pairs a device, answers the documented shape and sets the cookie`.
- **Fixed: bearer for native clients only.** Before, any request could authenticate with
  `Authorization: Bearer`. Now a request carrying an `Origin` header (a browser page) is authenticated by
  the cookie only. Tests: `src/stream/server.test.ts > upgrade and authentication > security: refuses the bearer header from a browser page and any Origin that is not allowed (4003)`,
  `> reads tokens from bearer or cookie headers`.
- **Fixed: cross-site WebSocket hijacking.** `SameSite=Strict` does not separate two ports on the same
  host name (same site), so a page served from another port of the Mac could have opened a stream with
  the cookie. The upgrade now closes 4003 `origin not allowed` unless the `Origin` is the host's own
  origin; native clients send no `Origin`. Test:
  `src/http/server.test.ts > stream authentication > security: accepts the cookie from the host’s own origin and refuses other origins with 4003`.
- **Fixed: crash on a malformed cookie.** A `nano_device` value that is not valid percent-encoding made
  `decodeURIComponent` throw inside the async upgrade handler: an unhandled rejection that stops the Node
  process, triggerable before authentication. It now counts as no token (4003). Test:
  `src/stream/server.test.ts > upgrade and authentication > security: a malformed cookie is no token (4003), not a crash`.
  With the fix removed the test run hangs instead of passing.
- Token never logged: same end-to-end log test as item 1 (the token and the cookie value are absent).

## 3. Revocation: Pass

`device/revoke` and `nano-host devices revoke` clear the hash (the row stays, marked revoked) and close
every open stream of the device with 4003 at once; a new upgrade with the revoked token gets 4003.
Tests: `src/http/server.test.ts > device methods > revoke closes the other device’s open stream with 4003 at once and invalidates its token`
(includes the reconnect), `> a device that revokes itself gets its response before the stream closes`,
`> the internal API revokes a device for the CLI`,
`src/cli/service.test.ts > host service > revoking through the control channel closes the device stream with 4003`,
and the end-to-end security test (revoke over the control channel, then reconnect with the old token: 4003).

## 4. Binding and TLS: Pass after fix

- Only literal tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) or loopback addresses; `0.0.0.0`, `::`, host
  names and other interfaces are refused before anything listens; config validation also refuses
  wildcards. Tests: `src/http/bind.test.ts > bind check > refuses wildcards, hostnames and non-tailnet interfaces`,
  `src/http/server.test.ts > binding and TLS > refuses to bind 0.0.0.0`.
- TLS required; plain HTTP only with `insecureDev` and only on loopback. Test:
  `src/http/bind.test.ts > bind check > allows plain HTTP only on loopback with insecureDev`.
- **Fixed: certificate and key 0600.** Only the key was tightened, and only by `nano-host cert`. Now the
  server tightens both files to 0600 before reading them at every start (a file it cannot chmod fails the
  start with the TLS explanation), and `nano-host cert` tightens both. Test:
  `src/http/server.test.ts > binding and TLS > serves HTTPS and wss from the cert and key files, on every address`
  (files start 0644, are 0600 once serving).

## 5. Files: Pass after fix

| File | Mode | Test |
|---|---|---|
| NanoHost folder | 0700, forced on every start | `src/cli/service.test.ts > … security: no token, code, …` |
| `config.json` | 0600 | `src/cli/config.test.ts > config file > writes defaults on first start: folder 0700, file 0600, and reads them back unchanged` |
| `journal.sqlite` and `-wal`, `-shm` (Journal and device hashes) | 0600 | `src/config/private-files.test.ts > private files > security: the Journal and the device store are 0600, with their WAL files, in a new 0700 folder` |
| `control.secret`, `control.sock` | 0600 | `src/cli/control.test.ts > control secret > is created once with mode 0600 and reused`; end-to-end test |
| `vapid.json` | 0600 | `src/push/vapid.test.ts > VAPID key pair > security: is generated on first start as a P-256 pair in a 0600 file, and reused afterwards` |
| TLS certificate and key | 0600 | item 4 |
| `host.log`, launchd `stdout.log`, `stderr.log` | 0600 in a 0700 folder | `src/cli/log.test.ts > structured log > writes one JSON line per event to stdout and the log file (0600)`, `src/cli/launchd.test.ts > install and uninstall > writes the plist, creates the log folder and bootstraps into gui/<uid>` |

Fixes: SQLite created the database 0644; the file is now created 0600 before SQLite opens it (SQLite
gives its WAL and shared-memory files the main file's mode), and existing files are tightened. The
NanoHost folder was tightened only when the config file was first written; the service now forces 0700
on every start. launchd created its output files 0644; `install` now creates them 0600 first.

Accepted risk: when `journalPath` points outside the NanoHost folder, the host makes the file 0600 but
leaves the user's folder mode alone. Test: `src/config/private-files.test.ts > private files > security: tightens an existing database file and leaves a folder the user chose alone`.

## 6. Web Push preparation (Phase 3): Pass after fix

- VAPID key pair (P-256) generated on first start into `vapid.json` 0600 next to the config:
  `{publicKey: base64url 65-byte uncompressed point, privateKey: base64url 32-byte scalar, createdAt}`.
  It is never rotated automatically, because a new key orphans every subscription; a damaged file stops
  the start with an explanation instead of being replaced silently. Tests: `src/push/vapid.test.ts > VAPID key pair > …`
  (all four; the first also signs ES256 with the stored key and verifies with the public key).
- `initialize` advertises it: `push: {vapidPublicKey, subscribed: false}`. No schema change: the field
  already existed and carried `''`. Test: the end-to-end security test in `src/cli/service.test.ts`.
- Push subscription table, designed and not wired (Phase 3 adds it to the same SQLite file as `devices`):

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  client_id TEXT NOT NULL REFERENCES devices(client_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,          -- subscription.endpoint, copied out for uniqueness and deletion on 404/410
  subscription TEXT NOT NULL,      -- the PushSubscription JSON as sent to push/subscribe (endpoint, keys.p256dh, keys.auth)
  created_at INTEGER NOT NULL,     -- Unix seconds
  PRIMARY KEY (client_id, endpoint)
);
```

  Rules for Phase 3: `push/subscribe` replaces the row for the same endpoint; `push/unsubscribe` deletes
  the client's rows; `device/revoke` deletes the revoked device's rows in the same transaction that clears
  its hash (a revoked phone must not keep getting titles); a push service answer of 404 or 410 deletes the
  row. `keys.auth` is a secret: the subscription JSON is never logged. Payloads stay `{title, body, url}`
  (spec 9).

## 7. Logs: Pass after fix

- The structured logger replaces any field whose name says token, code, cookie, secret, password,
  authorization or credential, at any depth. Test:
  `src/cli/log.test.ts > structured log > never writes tokens, codes, cookies or secrets, at any depth`.
- End-to-end: the service pairs (a wrong code, then a real one), connects with the cookie, runs a turn
  whose text is a marker, revokes, reconnects; the log file and stdout contain none of the token, the
  codes, the control secret or the marker. Test:
  `src/cli/service.test.ts > host service > security: no token, code, cookie or session content in the log; private files; VAPID key in initialize`.
- **Fixed:** a Codex stdout line that was not JSON was logged with its first 200 characters, which can be
  session content. Now only its length is logged.

Accepted risk: Codex's own stderr is logged as is, because it is the only diagnosis when the engine
fails. At the default log level it carries warnings and errors, which can name a command or a path. The
log file is 0600 in a 0700 folder, readable only by the same user who can read the Journal, which holds
the full sessions anyway.

## 8. Dependencies: Pass

`pnpm audit` on 2026-10-20: "No known vulnerabilities found". Runtime dependency of the host: `ws` only;
everything else is built-in (`node:sqlite`, `node:crypto`) or dev-only.

## 9. Control channel: Pass

HTTP over `control.sock` (0600) in the 0700 NanoHost folder; every request needs the 32-byte secret from
`control.secret` (0600), compared in constant time; without it the answer is 401, and a client that cannot
read the secret file never connects. Tests: `src/cli/control.test.ts > control secret > is created once with mode 0600 and reused`,
`> replaces a truncated secret`, `src/cli/control.test.ts > control channel round trip > refuses a request without the right secret`,
`> reports a host that is not running`.

## Not in the checklist, noted

- `POST /v1/pair` from another site cannot succeed: it requires `application/json`, which forces a CORS
  preflight the host never approves.
- The cookie lives 400 days (`Max-Age`); revocation is the control for a lost device.
