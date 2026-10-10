# XHS Research Studio — Hosted paid-beta runbook

Hosted mode turns the local Research Studio into an authenticated, paid, workspace-isolated service while preserving the same evidence and safety model.

## Release boundary

Hosted paid beta is designed for a **single application replica with one persistent `/data` volume**. The hosted control plane uses Node's built-in `node:sqlite` API with WAL mode and stores Harvest snapshots / run artifacts as files under the same data volume.

Do **not** run multiple application replicas against the same SQLite/data volume. `node:sqlite` is still documented by Node.js as an active-development API. Multi-region, multi-writer, HA database operation is outside this paid-beta release boundary and requires migration to an external transactional database/object store.

Local mode remains the default. `XHS_STUDIO_HOSTED=1` is required to enable hosted authentication, billing, workspaces and shares.

## Required hosted production configuration

Set these through the deployment secret/configuration system. Never commit real values.

```text
XHS_STUDIO_HOSTED=1
XHS_STUDIO_PUBLIC_URL=https://research.example.com

# Evidence authentication; use independent high-entropy values >= 32 UTF-8 bytes.
XHS_STUDIO_INTEGRITY_KEY=...
XHS_STUDIO_INTEGRITY_KEY_ID=snapshot-prod-v1
XHS_STUDIO_PACK_INTEGRITY_KEY=...
XHS_STUDIO_PACK_INTEGRITY_KEY_ID=pack-prod-v1

# Stripe
XHS_STUDIO_STRIPE_SECRET_KEY=...
XHS_STUDIO_STRIPE_WEBHOOK_SECRET=...
XHS_STUDIO_STRIPE_PRICE_PILOT=price_...
XHS_STUDIO_STRIPE_PRICE_PRO=price_...

# Authorized Harvest executor adapter
XHS_STUDIO_HARVEST_EXECUTOR=/absolute/path/to/trusted-executor
XHS_STUDIO_HARVEST_EXECUTOR_ARGS=["..."]
```

For grounded synthesis, configure **one** trusted path:

```text
# Enterprise/fixed gateway adapter (preferred when an internal gateway exists)
XHS_STUDIO_SYNTHESIS_EXECUTOR=/absolute/path/to/trusted-synthesis-adapter
XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS=["..."]
```

or:

```text
XHS_STUDIO_OPENAI_API_KEY=...
XHS_STUDIO_OPENAI_MODEL=...
```

The model/provider output is not trusted directly. Every synthesized fact, inference, recommendation and counter-evidence item is revalidated locally against note/comment evidence IDs. Unsupported population-prevalence language is rejected.

## Reverse proxy and cookies

- Expose the container port on loopback and terminate public TLS at a trusted reverse proxy.
- `XHS_STUDIO_PUBLIC_URL` must be the exact public HTTPS origin. Hosted session cookies become `Secure` when this origin is HTTPS.
- Leave `XHS_STUDIO_TRUST_PROXY=0` unless the application is reachable **only** through a proxy that overwrites untrusted forwarding headers.
- When proxy trust is enabled, login/registration throttling uses the first trusted `X-Forwarded-For` address.
- State-changing browser requests are same-origin checked and the session cookie is `HttpOnly; SameSite=Lax`.

## Authentication and workspace isolation

- Passwords are stored as scrypt-derived hashes with per-user salts.
- Raw session, invitation and share tokens are never persisted; only SHA-256 token hashes are stored.
- Failed logins are throttled by both `(email, client IP)` and client IP using persistent SQLite counters.
- Account registration is IP-throttled before expensive password hashing to reduce CPU abuse.
- Roles: `owner`, `admin`, `analyst`, `viewer`.
- Cross-workspace project lookup returns `404` rather than disclosing project existence.
- Invitations are email-bound, role-bound, expiring, revocable and single-use.

## Billing truth and usage semantics

Stripe is the external billing source of truth.

- Checkout sessions are created server-side using configured recurring Price IDs.
- Workspace/plan IDs are carried in Stripe metadata.
- Entitlements change only after a correctly signed raw-body Stripe webhook is accepted.
- Billing webhook event IDs are idempotent.
- Stripe Billing Portal handles invoices, payment methods and cancellation/subscription management.
- `active` and `trialing` subscriptions can create projects/runs; inactive/canceled/past-due entitlement states fail closed.
- A **new run launch** reserves one monthly run unit atomically.
- Resuming the **same run ID** after a manual login/CAPTCHA handoff revalidates entitlement/budget but does not consume another monthly run unit.
- Actual note/comment counts are recorded after a valid executor result passes strict Harvest v2 and server-side sample-budget validation.

## Harvest execution safety boundary

The Studio executes only the configured fixed adapter command with `shell:false`. It does not implement platform bypass behavior.

- public or user-authorized read-only collection only
- no CAPTCHA bypass
- no login/access-control bypass
- no account/IP rotation or fingerprint spoofing
- hard platform/access states become `manual_action_required`
- scheduled monitoring pauses after a manual safety handoff until explicitly re-enabled
- automatic executor output must be strict Harvest v2
- server-enforced note/comment budgets are checked again before snapshot commit

## Persistence, backup and restore

The persistent volume contains both the hosted control-plane database and evidence/run objects. Treat it as one recovery unit.

Typical contents include:

```text
/data/hosted.sqlite
/data/hosted.sqlite-wal
/data/hosted.sqlite-shm
/data/projects.json
/data/snapshots/
/data/runs/
/data/schedules.json
```

### Paid-beta backup procedure

For a consistent recovery point:

1. Stop new traffic and stop the application cleanly.
2. Snapshot/archive the **entire `/data` volume**, not only `hosted.sqlite`.
3. Back up integrity/HMAC keys and historical keyrings separately in the secret manager.
4. Restart and confirm `/api/health` plus an authenticated read.

Do not copy only the live SQLite main file while the service is running in WAL mode.

### Restore drill

1. Start a fresh single-replica deployment with the same application version.
2. Restore the entire `/data` backup while the app is stopped.
3. Restore the current integrity keys/key IDs and required historical verification keyring.
4. Start the service.
5. Verify login, workspace/project listing, historical snapshot integrity, Evidence Pack export and a no-op/manual executor state before allowing new writes.

A paid deployment should perform periodic restore drills. A backup that has never been restored is not considered verified.

## Integrity keys and rotation

Snapshot HMAC and Evidence Pack HMAC are separate concerns and should use separate secrets.

- New snapshot writes use the current `XHS_STUDIO_INTEGRITY_KEY` + key ID.
- Historical snapshot keys may be supplied read-only through `XHS_STUDIO_INTEGRITY_KEYRING`.
- Evidence Pack authentication uses its own Pack key/key ID.
- SHA-256 checksum-only records detect accidental mutation but are **not** authenticated evidence.
- Never delete an old snapshot verification key until all evidence that depends on it has passed its retention period or has been migrated under an explicitly reviewed process.

## Deployment gates

A hosted paid-beta candidate is not releasable unless the current commit passes all of these on GitHub Actions:

- syntax checks
- core unit/security/compatibility/scale tests
- local API smoke
- hosted paid-beta API smoke
- local Headless Chrome smoke
- hosted Headless Chrome self-service smoke
- hardened Docker build
- non-root/read-only-root local container + persistence/executor gate
- hosted container auth/billing/run + persistence restart gate

The paid-beta acceptance regression additionally requires a second controlled run to demonstrate content, comment/theme and rank differences, attention alerts, and source-traceable theme evidence.

## External release prerequisites

Code/CI success cannot manufacture external credentials. Before accepting real customer payment, the operator must separately verify:

- production DNS/TLS/reverse proxy
- real Stripe account, recurring Prices, webhook endpoint and Billing Portal configuration
- legal/tax/business information required by the payment processor and customer contracts
- a real authorized Harvest adapter/runtime for the intended account/data boundary
- a production secret manager and backup destination
- an incident owner and restore procedure

Do not mark these external prerequisites as completed based on mock CI credentials.
