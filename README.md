# RukwaRide

Ride-hailing platform for Rukwa region, Tanzania (launch city: Sumbawanga). Built to
[`rukwa-ride-hailing-build-spec.md`](rukwa-ride-hailing-build-spec.md) — bodaboda/bajaji-first,
cash-first, LATRA fare-regulated, flaky-3G-tolerant.

## Status — build phases (spec §18)

| Phase | Status |
|---|---|
| 1. Foundation: monorepo, shared package (enums, Zod contracts, fare engine, state machine), Prisma schema + seed, OTP auth (mock SMS), RBAC guard | ✅ done |
| 2. Trip core: TripService state machine, **dispatch engine** (Redis GEO + offer cascade + BullMQ server-side timers), location ingestion, Socket.io, **fake-driver simulator** | ✅ done — simulator was built *first*, then the engine was proven against it |
| 3. Clients: passenger PWA (book/track/complete, installable), Expo driver app (online/offer/trip + background GPS), notification pipeline (DB templates sw/en, socket→FCM→SMS fallback, provider scaffolds), refresh tokens | ✅ done |
| 4. Money: LedgerService (balanced txns enforced), wallet top-up, mobile-money trip payment with 120 s convert-to-CASH timeout, signed webhooks (idempotent), admin-approved payouts, nightly reconciliation, aggregator adapter scaffold | ✅ done |
| 5. Ops: staff console (dispatcher board/map/create-for-caller, manual assign + FORCE-ACCEPT, admin dashboard/documents/drivers/fares/ledger/LATRA/tickets/audit), LATRA module (report outbox, vehicle verification), staff password auth | ✅ done |
| 6. Hardening: rate limits + helmet + CORS lockdown, pino/Prometheus/Sentry, Playwright E2E, prod Docker (caddy/backup/OSRM/monitoring), CI + tag deploy, RUNBOOK, NFR load test | ✅ done |

## Layout

```
apps/api/          NestJS 10 + Fastify + Socket.io + BullMQ + Prisma — THE backend
apps/web/          Next.js 15 passenger PWA (mobile-first, Swahili default, MapLibre, installable)
apps/driver/       Expo (Android) driver app — background GPS foreground service, offer screen
packages/shared/   enums, trip state machine, fare engine, geo utils, socket/DTO contracts (Zod)
scripts/           fake-driver simulator (sim-drivers.ts), smoke.ts, dispatch integration tests
infra/             dev docker-compose (Postgres 16 + Redis 7), dev JWT keys
```

## Quickstart

```bash
pnpm install
pnpm infra:up                       # Postgres :5433, Redis :6380
cp .env.example .env                # then point JWT_*_KEY_PATH at infra/keys (absolute paths)
cp .env .env.api && cp .env apps/api/.env
pnpm db:migrate && pnpm db:seed     # schema + LATRA bounds/fares/landmarks/sim cohort
pnpm build                          # shared + api
cd apps/api && node --env-file=.env dist/main.js
```

Dev JWT keys: `openssl genrsa -out infra/keys/dev-jwt-private.pem 2048 && openssl rsa -in infra/keys/dev-jwt-private.pem -pubout -out infra/keys/dev-jwt-public.pem`

## Clients

**Passenger PWA** — `pnpm --filter @rukwaride/web dev` → http://localhost:3000. Phone+OTP login
(mock SMS prints the code in the API log), landmark/pin destination, per-class fare estimates
("Kadirio"), live trip screen (socket + 5 s polling fallback for flaky 3G), rating, history with
receipts. Installable (manifest + offline-shell service worker). Env:
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TILE_URL`.

**Driver app (Android)** — `pnpm --filter @rukwaride/driver start` (Expo). On the Android
emulator the API is reached via `10.0.2.2:3001` (default); on a real device set
`EXPO_PUBLIC_API_URL=http://<lan-ip>:3001`. Going online starts an Android **foreground service**
(persistent notification) pinging GPS every 5 s via `expo-location` + `expo-task-manager`;
offline pings queue in memory and flush over HTTP on reconnect. Permissions (declared in
app.json): `ACCESS_FINE_LOCATION`, **`ACCESS_BACKGROUND_LOCATION`** (Play review requires a
justification video — spec §20), `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.
Background-location + notifications need a **dev build** (`pnpm --filter @rukwaride/driver android`),
not Expo Go — and adding `@maplibre/maplibre-react-native` (embedded course map with the OSRM
route) means the dev build must be **re-cut** after pulling this version. The app also shows a
**trip board** ("abiria wanasubiri karibu"): nearby passengers still searching, pushed over the
socket (`tripboard:new`) and claimable via `POST /drivers/me/trip-board/:tripId/claim` unless the
driver is on a trip. **FCM offer wake is implemented server-side** (`FcmHttpV1Provider`, HTTP v1):
set `PUSH_PROVIDER=fcm` + `FCM_SERVICE_ACCOUNT_JSON(_PATH)` on the API and add
`google-services.json` to the dev build; without credentials the mock provider logs pushes and the
socket + SMS chain still delivers. Remaining gap: in-app document upload (uses the web `/driver`
onboarding flow).

**Notifications** — templates live in the `NotificationTemplate` table (sw/en, `{{var}}`
substitution), seeded. Chain: socket presence check → FCM push → SMS; LATRA-critical events
(driver assigned/arrived/started/receipt) always send SMS. Providers are pluggable:
`SMS_PROVIDER=mock|real` (real = Africa's Talking-style HTTP scaffold, needs `SMS_API_URL`/`SMS_API_KEY`),
`PUSH_PROVIDER=mock|fcm` (fcm scaffold awaits `FCM_SERVICE_ACCOUNT_JSON`).

## Staff console & LATRA (spec §12/§13)

- **Staff login**: `/staff/login` on the web app — phone + password (Argon2id). Dev seed:
  admin `+255700000001`, dispatcher `+255700000002`, password `ChangeMe123!`
  (override via `SEED_ADMIN_PASSWORD` / `SEED_DISPATCHER_PASSWORD` before seeding).
- **Dispatcher** (`/staff/dispatch`): book for a phone caller (landmark pickup/destination,
  SMS-driven lifecycle), live driver map (5 s poll), active trips board, manual assign
  (60 s offer) or **FORCE-ACCEPT** for drivers with the standing-consent flag, reassign,
  cancel, waive cancellation fee. Every mutation lands in `AuditLog`.
- **Admin** (`/staff/admin/…`): dashboard (trips/day, completion/cancellation rates, active
  drivers, revenue), document review queue, driver management (approve, block, wallet adjust
  with mandatory memo → balanced ledger txn, consent flag, LATRA vehicle verification with
  logged override), fare-config editor (rejections name the exact LATRA band violated; change
  history kept), ledger browser + on-demand reconciliation, LATRA report outbox with retry,
  support tickets, audit viewer.
- **LATRA module** (`apps/api/src/latra`): trip-report outbox — every COMPLETED/CANCELLED trip
  creates a `LatraReport` row + queued submission (5 attempts, exponential backoff; FAILED
  reports surface to admin). `LatraClient` is pluggable: mock by default, OAuth2
  client-credentials scaffold behind `LATRA_CLIENT=real` + `LATRA_*` envs.

## Money (spec §9)

- **LedgerService** is the only money write-path: every movement is a balanced multi-line
  transaction (validated before any row is written); `walletBalance` is a cache updated in the
  same DB transaction and re-derived nightly (03:00 reconciliation job + `POST
  /payments/admin/reconcile`). Drift and global imbalance land in `AuditLog`.
- **Cash trips** (default): commission + booking fee debited from the driver wallet on completion.
- **Mobile-money trips**: collection push to the passenger on completion; unconfirmed after
  `PAYMENT_TIMEOUT_S` (120 s) → payment FAILED and the trip converts to CASH with the cash
  settlement booked — a trip is never left in payment limbo. Driver told in-app, passenger by SMS.
- **Top-up**: `POST /payments/topup` → collection push to the driver's phone → webhook confirms →
  `DEBIT AGGREGATOR_CLEARING / CREDIT DRIVER_WALLET`.
- **Payouts**: driver `POST /payments/payouts` → admin approve (money reserved in a balanced txn,
  then `disburse()`; reversal txn on failure) → disbursement webhook marks PAID. Never automatic.
- **Webhooks**: `POST /payments/webhook`, HMAC-SHA256 over the raw body in
  `x-rukwaride-signature` (secret `PAYMENT_WEBHOOK_SECRET`); 200-fast then queue-processed;
  duplicates absorbed by the PENDING-only transition. `PAYMENT_PROVIDER=mock|real` — the real
  adapter is a Selcom/AzamPay/ClickPesa-shaped scaffold awaiting operator credentials.

## The simulator (test harness for everything dispatch)

Virtual drivers that connect over the real Socket.io contract, ping GPS on the real cadence,
accept/decline/ignore offers, and drive trips through the full lifecycle:

```bash
# 10 drivers with realistic mixed behavior + 3 auto-created passenger trips
pnpm sim -- --drivers 10 --behavior mixed --trips 3 --ping 1000 --speed 25
# flags: --class BODABODA|BAJAJI|CAR  --behavior accept|decline|ignore|mixed
#        --accept-delay ms  --spread m  --ping ms  --speed m/s  --api url  --trips n
```

`scripts/smoke.ts` runs one full booked→completed trip end-to-end and exits 0/1.

## Tests

```bash
pnpm --filter @rukwaride/shared test   # 628 unit tests: exhaustive transition matrix,
                                       # fare golden files, GPS-jump filter
pnpm build && pnpm --filter @rukwaride/scripts test
                                       # integration suites (own API, compressed timers):
                                       # dispatch — lifecycle + balanced ledger, decline
                                       # cascade, offer TTL expiry, lock contention,
                                       # stale-driver exclusion, idempotent accept;
                                       # money — top-up webhook (idempotent, bad-sig
                                       # rejected), momo trip settlement split,
                                       # timeout→CASH conversion, admin payout + audit,
                                       # global ledger sum-zero + reconciliation.
```

Integration tests need the dev docker-compose up. They reset sim-world state between tests.

```bash
pnpm --filter @rukwaride/scripts e2e   # Playwright (Chromium): passenger books→completes→rates;
                                       # dispatcher books for a phone caller. Needs API :3001 +
                                       # web :3000 running (auto-started if not).
SEED_SIM_DRIVERS=320 SEED_SIM_PASSENGERS=120 pnpm db:seed
pnpm --filter @rukwaride/scripts load-test
                                       # §15 NFR run: 300 drivers @3s pings (100 msg/s),
                                       # 60 concurrent trips for 5 min; prints a pass/fail
                                       # report for dispatch p95 <3s and HTTP p95 <300ms.
```

Reference load-test result (2026-07-07, dev laptop, dev API with pino info logging):
300 drivers online, 60 trips held active for 5 min, 35,062 pings ingested —
**dispatch decision p95 0.227 s** (target 3 s), **HTTP p95 26 ms** over 8,952 requests
with 0 errors (target 300 ms), 103 trips completed, none expired.

## Production (spec §17)

- `infra/docker-compose.prod.yml`: caddy (TLS) · api · web · postgres · redis · nightly
  pg_dump backup (30-day retention) · `--profile routing` OSRM · `--profile monitoring`
  Prometheus + Grafana + uptime-kuma. Dockerfiles live in `apps/api` and `apps/web`
  (pnpm-pruned, standalone Next output).
- OSRM data prep: `infra/osrm/setup.sh` (Geofabrik Tanzania, car profile, MLD).
- CI (`.github/workflows/ci.yml`): typecheck → unit → build → migrate/seed → integration
  suites against service containers; on `v*` tags builds/pushes images to GHCR and SSH-deploys
  with `prisma migrate deploy` + a health-check gate.
- Ops procedures (deploy, rollback, restore, key rotation, OSRM refresh, incident playbooks):
  [docs/RUNBOOK.md](docs/RUNBOOK.md).
- Security: Redis rate limits on OTP/login/trip-creation/top-up, OTP 1/min + 5/day per phone,
  helmet headers, CORS locked to `WEB_ORIGINS`, pino logs with auth/phone redaction, webhook
  HMAC over raw bytes, `/metrics` blocked at the proxy.

## Key invariants (do not break)

- `TripService.transition()` is the **only** code path that mutates `Trip.status` — row lock,
  `canTransition()` check, `TripStatusEvent` append, one Postgres transaction.
- All dispatch timing is **server-side BullMQ jobs** (offer TTL, search retry, staleness sweep).
  Clients only render countdowns.
- Offer acceptance is race-safe: Redis `lock:driver:{id}` (NX) + `offerSeq` check inside the DB
  transaction. First accept wins; repeats are idempotent no-op successes.
- Every money movement is a balanced ledger txn (`LedgerEntry` rows per `txnId` sum to zero);
  `walletBalance` is a cache.
- Fare configs are validated against `LatraBounds` (seeded `VERIFY BEFORE LAUNCH`). No surge
  pricing, ever.
- Redis is rebuildable; nothing critical lives only in Redis.
- Instances sharing one Redis but NOT meant to cooperate (test API next to dev API) must set
  distinct `QUEUE_PREFIX` + `SOCKET_ADAPTER_KEY`, or they steal each other's BullMQ jobs with
  different timing configs. Replicas that should share work keep the defaults.

## Live demo (free, no SMS, no VPS)

Put the whole platform online for real-device testing over a free
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
with **demo OTP** (login code shown on screen instead of texted — no SMS account needed):

```bash
bash scripts/demo-live.sh          # prints a public https://…trycloudflare.com URL
bash scripts/demo-live.sh stop     # tear it down
```

It builds + starts the API (with `AUTH_DEMO_MODE=true`), the web app in a
**same-origin** build, a local Caddy that fronts web + API on one port
(`infra/caddy-demo/Caddyfile` — so the tunnel needs a single hostname and
cookies/CORS just work), 8 road-following sim drivers, and the cloudflared
tunnel. Passenger login: enter any `+255…` number and the OTP appears on the
login screen. Staff console at `/staff/login` (`+255700000001` / `ChangeMe123!`).
Needs the dev infra (Postgres/Redis) and the OSRM container up.
`AUTH_DEMO_MODE` must never be set in production.
