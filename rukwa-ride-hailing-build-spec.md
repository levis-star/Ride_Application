# RukwaRide — Build Specification

**Audience:** Claude Code (autonomous implementation)
**Goal:** A commercially operable ride-hailing platform for Rukwa region, Tanzania (launch city: Sumbawanga).
**Status:** v1.0 — MVP scope. Anything not listed under "In Scope" is out of scope. Do not add features speculatively.

---

## 1. Context (read this — it drives every design decision)

- **Market:** Sumbawanga, Rukwa region. Low ride density. Supply is **bodaboda (motorcycle)** and **bajaji (3-wheel tricycle)** first, cars second.
- **Payments:** Cash is the dominant payment method. Mobile money (M-Pesa, Airtel Money, Mixx by Yas, HaloPesa) second. Card payments are irrelevant at launch — do NOT integrate Stripe.
- **Network:** Assume flaky 3G. Everything must tolerate disconnects: queue-and-retry on clients, server-side timers, SMS fallback for critical events.
- **Addresses barely exist.** No street-address geocoding. Location = map pin + named landmarks database.
- **Regulation:** Ride-hailing in Tanzania is licensed and fare-regulated by LATRA. Fares must stay within LATRA-approved bands; platform commission is capped (currently max 25% commission + 3% booking fee — store as config, never hardcode). LATRA also requires a reporting API integration (OAuth 2.0) and vehicle verification against LATRA records before onboarding. **There is no surge pricing in this product. Do not build it.**
- **Not all passengers have smartphones.** A staff **dispatcher console** (book a trip on behalf of a phone caller) is a first-class feature, not an afterthought.

---

## 2. MVP Scope

### In scope
- Passenger web app (mobile-first PWA)
- Driver mobile app (React Native / Expo, Android-only at launch)
- Admin + dispatcher web console
- One backend API + realtime service
- Vehicle classes: `BODABODA`, `BAJAJI`, `CAR`
- Payments: cash + one mobile-money aggregator (behind an adapter; ship with mock provider + one real adapter scaffold)
- Driver wallet + double-entry ledger + commission settlement
- Dispatch engine (auto-match with offer cascade) + manual dispatch
- Trip lifecycle with full state machine
- Phone OTP auth (SMS), FCM push, SMS fallback notifications
- Self-hosted routing (OSRM) + MapLibre map tiles
- LATRA compliance module (fare bounds config, trip reporting stub, vehicle verification hook, driver identity display, e-receipt)
- Ratings (both directions), trip history, saved places/landmarks
- Observability, tests, Docker deployment for a single VPS

### Explicitly out of scope (MVP)
- Surge pricing (regulated fares — permanently out)
- Card payments / Stripe / Flutterwave cards
- iOS driver app
- Scheduled rides, ride sharing/pooling, deliveries
- In-app voice calls (use `tel:` deep links — everyone has airtime)
- Promo codes, referral programs
- Multi-city support (build config so a second city is a data row, not a code change — but ship one city)
- Microservices, Kubernetes, multi-region anything

---

## 3. Architecture

**One modular-monolith backend.** No Express-plus-Next duplication, no microservices. One deployable API process that also hosts Socket.io.

```
repo/  (pnpm workspaces + Turborepo)
├── apps/
│   ├── api/            # NestJS (Fastify adapter). REST + Socket.io gateway. THE backend.
│   ├── web/            # Next.js 15 (App Router). Passenger PWA + Admin + Dispatcher (role-gated routes).
│   └── driver/         # Expo (React Native, TypeScript). Android driver app.
├── packages/
│   ├── shared/         # Zod schemas, DTO types, enums, fare-engine pure functions (shared by all apps)
│   └── config/         # eslint, tsconfig, prettier presets
├── infra/
│   ├── docker-compose.yml          # dev
│   ├── docker-compose.prod.yml     # prod (single VPS)
│   └── osrm/                       # OSRM setup scripts (Tanzania OSM extract from Geofabrik)
└── docs/
```

**Key decisions (do not revisit):**
- **NestJS modules:** `auth`, `users`, `drivers`, `vehicles`, `trips`, `dispatch`, `locations`, `fares`, `payments`, `ledger`, `notifications`, `landmarks`, `latra`, `admin`, `support`.
- **PostgreSQL 16 + Prisma** for all transactional data. **PostGIS is NOT required** — proximity search lives in Redis; Postgres stores coordinates as plain `Decimal` lat/lng columns.
- **Redis 7** for: driver live locations (GEO), dispatch locks, offer TTLs, Socket.io adapter, BullMQ queues, rate limiting.
- **BullMQ** for background jobs: offer timeout cascade, SMS/push sending, LATRA report submission, ledger settlement, nightly reconciliation.
- **Next.js talks to the API over HTTP only.** No database access from `apps/web`. No Next.js API routes except NextAuth-free session cookie helpers if needed — auth is owned by `apps/api`.
- Socket.io uses the Redis adapter from day one (allows 2+ API replicas later without rework).

---

## 4. Tech stack (pinned)

| Concern | Choice |
|---|---|
| Language | TypeScript everywhere (strict mode) |
| Backend | NestJS 10 + Fastify, Socket.io 4, BullMQ |
| DB / ORM | PostgreSQL 16, Prisma (latest stable) |
| Cache / geo / queues | Redis 7 |
| Web | Next.js 15, React 19, Tailwind, shadcn/ui, MapLibre GL JS |
| Driver app | Expo SDK (latest stable), expo-location, expo-task-manager (background location), react-native-maps or MapLibre RN |
| Validation | Zod (single source of truth in `packages/shared`, consumed by API pipes and clients) |
| Auth | Phone + OTP → short-lived JWT access (15 min) + rotating refresh tokens (httpOnly cookie on web, SecureStore on driver app) |
| Push | Firebase Cloud Messaging (driver app + web push for passengers) |
| SMS | Pluggable `SmsProvider` interface. Implement `MockSmsProvider` (logs to console/DB) + one real adapter scaffold (Africa's Talking-style HTTP API). Operator supplies credentials. |
| Mobile money | Pluggable `PaymentProvider` interface. Implement `MockPaymentProvider` + one aggregator adapter scaffold (Selcom/AzamPay/ClickPesa-style: initiate collection push, disbursement, signed webhook). Operator picks the aggregator and supplies credentials. |
| Routing/ETA | Self-hosted OSRM with Geofabrik Tanzania extract. Haversine ×1.4 road factor as fallback when OSRM is down. |
| Map tiles | MapLibre + configurable raster/vector tile URL (env var). Default to OSM raster tiles for dev; operator supplies a tile provider key for prod. |
| Observability | pino structured logs, Sentry (all 3 apps), Prometheus metrics endpoint + Grafana, uptime-kuma |
| CI | GitHub Actions: typecheck, lint, test, build, docker build |

---

## 5. Data model (Prisma — implement exactly these entities)

Enums:
```
Role: PASSENGER | DRIVER | DISPATCHER | ADMIN
VehicleClass: BODABODA | BAJAJI | CAR
DriverStatus: OFFLINE | AVAILABLE | ON_OFFER | ON_TRIP
TripStatus: REQUESTED | SEARCHING | OFFERED | ACCEPTED | ARRIVED | IN_PROGRESS | COMPLETED | CANCELLED_BY_PASSENGER | CANCELLED_BY_DRIVER | EXPIRED | FAILED
TripSource: PASSENGER_APP | DISPATCHER
PaymentMethod: CASH | MOBILE_MONEY
PaymentStatus: PENDING | CONFIRMED | FAILED | REFUNDED
LedgerAccount: DRIVER_WALLET | PLATFORM_REVENUE | PLATFORM_RECEIVABLE | PASSENGER_ESCROW | AGGREGATOR_CLEARING
DocumentType: NATIONAL_ID | DRIVING_LICENSE | LATRA_VEHICLE_LICENSE | INSURANCE | VEHICLE_PHOTO | DRIVER_PHOTO
DocumentStatus: PENDING_REVIEW | APPROVED | REJECTED | EXPIRED
```

Models (fields abbreviated — infer obvious columns; every model gets `id (cuid)`, `createdAt`, `updatedAt`):

- **User** — phone (unique, E.164), name, role, passwordHash (admin/dispatcher only; passengers/drivers are OTP-only), language (`sw` default, `en`), fcmToken?, isBlocked.
- **DriverProfile** — userId (1:1), status, currentVehicleId?, ratingAvg, ratingCount, walletBalance (Decimal, denormalized from ledger, reconciled nightly), negativeBalanceLimit (default from config), latraVerifiedAt?, approvedAt?.
- **Vehicle** — driverId, class, plateNumber (unique), make/model/color, latraLicenseNumber, latraVerified (bool), active.
- **DriverDocument** — driverId, type, status, fileUrl, expiresAt?, reviewedById?, rejectionReason?.
- **Trip** — passengerId?, createdById (user who created it — passenger or dispatcher), source, status, vehicleClass, pickupLat/Lng, pickupLandmarkId?, pickupNote?, dropLat/Lng, dropLandmarkId?, estimatedDistanceM, estimatedDurationS, estimatedFare, finalDistanceM?, finalDurationS?, finalFare?, fareBreakdown (JSON), paymentMethod, driverId?, vehicleId?, offeredDriverIds (String[]), acceptedAt?, arrivedAt?, startedAt?, completedAt?, cancelledAt?, cancellationReason?, statusHistory → relation.
- **TripStatusEvent** — tripId, fromStatus, toStatus, actorId?, at, meta (JSON). Append-only.
- **TripLocationPoint** — tripId, lat, lng, recordedAt, source (`DRIVER_GPS`). Batch-inserted; used for final distance calc and dispute review. Partition-friendly (index on tripId, recordedAt).
- **Payment** — tripId?, walletTopUp (bool), method, status, amount, currency (`TZS`), providerRef?, providerPayload (JSON), idempotencyKey (unique).
- **LedgerEntry** — txnId (groups a balanced transaction), account, driverId?, debit, credit, tripId?, paymentId?, memo. **Constraint: entries per txnId must sum to zero. Enforce in service layer + nightly reconciliation job.**
- **FareConfig** — vehicleClass (unique+active flag), baseFare, perKm, perMin, bookingFeePct, minimumFare, commissionPct, currency, effectiveFrom, latraOrderRef (text — which LATRA notice these values comply with). Admin-editable; validation refuses values outside `LatraBounds`.
- **LatraBounds** — vehicleClass, minFareFloor, perKmMin/Max, perMinMin/Max, commissionMax, bookingFeeMax, sourceRef. Seeded; admin-editable with audit log. (Do not hardcode current values in code — seed file only, marked `VERIFY BEFORE LAUNCH`.)
- **Landmark** — name (sw), aliasNames (String[]), lat/lng, category (market, hospital, school, stand, office, other), verified. Seeded with ~50 Sumbawanga landmarks (create seed file with placeholder coordinates flagged `TODO-OPERATOR: verify on ground`).
- **SavedPlace** — userId, label, lat/lng.
- **Rating** — tripId, raterId, rateeId, score 1–5, comment?.
- **SupportTicket** — openedById, tripId?, category, body, status, assignedToId?, resolutionNote?.
- **Notification** — userId, channel (PUSH|SMS|SOCKET), templateKey, payload JSON, sentAt?, failedAt?, error?.
- **AuditLog** — actorId, action, entity, entityId, before/after JSON. Written for every admin/dispatcher mutation.
- **OtpCode** — phone, codeHash, purpose, expiresAt, attempts, consumedAt?.
- **LatraReport** — tripId, payload JSON, status (PENDING|SENT|ACKED|FAILED), attempts, lastError?. (Outbox pattern for the LATRA API.)

---

## 6. Trip state machine (single source of truth)

Implement as a pure function in `packages/shared` (`canTransition(from, to, actor)`) + a `TripService.transition()` method that (a) runs inside a Postgres transaction, (b) appends a `TripStatusEvent`, (c) emits socket + push events, (d) enqueues side-effects. **No other code path may mutate `Trip.status`.**

| From | To | Trigger | Side effects |
|---|---|---|---|
| — | REQUESTED | passenger/dispatcher creates trip | validate fare estimate, persist |
| REQUESTED | SEARCHING | dispatch engine picks up | begin candidate search |
| SEARCHING | OFFERED | offer sent to a driver | Redis lock driver, 25s TTL job |
| OFFERED | SEARCHING | driver declines / offer TTL expires | unlock driver, next candidate |
| OFFERED | ACCEPTED | driver accepts (idempotent; first accept wins) | assign driver+vehicle, notify passenger (push+socket+SMS fallback), driver → ON_TRIP |
| SEARCHING | EXPIRED | no driver found after cascade exhausted (config: 5 candidates or 90s) | notify passenger, suggest retry |
| ACCEPTED | ARRIVED | driver taps "Arrived" (geofence check: within 150 m of pickup, warn-only) | notify passenger (push + **SMS always** — LATRA requires arrival notification) |
| ACCEPTED / ARRIVED | CANCELLED_BY_PASSENGER | passenger cancels | cancellation fee rules (§9), unlock driver → AVAILABLE |
| ACCEPTED / ARRIVED | CANCELLED_BY_DRIVER | driver cancels | strike counter on driver, re-dispatch same trip (back to SEARCHING) |
| ARRIVED | IN_PROGRESS | driver taps "Start trip" | start GPS trace recording, SMS to passenger (LATRA: trip-start notification) |
| IN_PROGRESS | COMPLETED | driver taps "End trip" | compute final fare (§9), create Payment + ledger entries (§10), SMS e-receipt to passenger (LATRA: trip-end notification), driver → AVAILABLE, request ratings |
| any pre-ACCEPTED | FAILED | internal error | alert ops |

Rules:
- Every transition is **idempotent** (repeat request with same target state = no-op success).
- All timeouts are **server-side BullMQ jobs**, never client timers.
- A driver can hold at most one non-terminal trip. A passenger can hold at most one non-terminal trip.

---

## 7. Dispatch engine

**Location ingestion:**
- Driver app sends GPS every 5 s while online (Socket.io event; batched HTTP POST fallback when socket is down — app queues points offline and flushes on reconnect).
- Server writes to Redis: `GEOADD geo:drivers:{vehicleClass} lng lat driverId` + `HSET driver:{id} status heading updatedAt`.
- A worker flushes points for **active trips only** to `TripLocationPoint` in batches (every 10 s). Idle-driver history is NOT persisted to Postgres.
- Staleness: drivers with no ping for 30 s are excluded from matching; 120 s → auto-set OFFLINE and notify them.

**Matching (on SEARCHING):**
1. `GEOSEARCH` radius 1 km → 3 km → 7 km (expanding) in the trip's vehicle class, status AVAILABLE, not in `offeredDriverIds`, wallet above block threshold.
2. Rank candidates by OSRM driving ETA to pickup (batch `/table` call; haversine fallback).
3. Offer to best candidate: `SET lock:driver:{id} tripId NX EX 30` — if lock fails, skip. Send offer via socket + FCM data message (offer must wake the app). Offer TTL 25 s.
4. Decline/timeout → release lock, next candidate. After 5 candidates or 90 s total → EXPIRED.
5. Accept is race-safe: `TripService.transition(OFFERED→ACCEPTED)` checks the Redis lock holder and current status inside the DB transaction.

**Manual dispatch (dispatcher console):** dispatcher can (a) trigger auto-dispatch, or (b) see nearest N drivers on a map and assign one directly (creates OFFERED with a longer 60 s TTL, or FORCE-ACCEPT for known drivers with their standing consent flag).

---

## 8. Fare engine (LATRA-compliant)

Pure, deterministic, fully unit-tested functions in `packages/shared`:

```
estimateFare(config, distanceM, durationS) → FareBreakdown
finalFare(config, actualDistanceM, actualDurationS) → FareBreakdown

FareBreakdown = { base, distanceCharge, timeCharge, bookingFee, subtotal,
                  minimumFareApplied: boolean, total, commission, driverEarnings }
```

Rules:
- `total = max(base + km*perKm + min*perMin + bookingFee, minimumFare)`, rounded to nearest 100 TZS.
- `commission = commissionPct * (total − bookingFee)`; `bookingFee` accrues to platform. Both validated against `LatraBounds` when config is saved — reject non-compliant configs with a clear error naming the bound violated.
- **Final distance** = sum of segment distances over the recorded `TripLocationPoint` trace with a GPS-jump filter (discard segments implying > 40 m/s for BODABODA/BAJAJI, > 50 m/s for CAR); fall back to OSRM route distance if trace has < 10 points.
- Estimate shown pre-booking must state "Kadirio" (estimate); final fare governs.
- Cancellation fee: 0 if cancelled before ACCEPTED; flat config amount (default TZS 500, admin-editable, LATRA-bounds-checked) if cancelled after driver has driven > 300 m toward pickup; waivable by dispatcher/admin.
- Currency: TZS only, integer amounts (no decimals).

---

## 9. Payments, wallet, ledger

**Every money movement is a balanced ledger transaction. The ledger is the source of truth; `walletBalance` is a cache.**

**Cash trip completion (the default path):**
- Passenger pays driver directly. Platform records:
  - `DEBIT DRIVER_WALLET(driver) commission` / `CREDIT PLATFORM_REVENUE commission`
  - `DEBIT DRIVER_WALLET(driver) bookingFee` / `CREDIT PLATFORM_REVENUE bookingFee`
- Driver wallet may go negative down to `negativeBalanceLimit` (default −TZS 15,000, config). Below limit → driver cannot go AVAILABLE until top-up. Driver app shows balance and top-up CTA prominently.

**Wallet top-up (mobile money):**
- Driver initiates in app → `PaymentProvider.initiateCollection(phone, amount, idempotencyKey)` → aggregator pushes USSD/STK-style prompt → webhook confirms → ledger: `DEBIT AGGREGATOR_CLEARING` / `CREDIT DRIVER_WALLET`.

**Mobile-money trip payment (passenger):**
- On COMPLETED with `MOBILE_MONEY`: collection push to passenger's phone. On confirm: `CREDIT DRIVER_WALLET (driverEarnings)` + `CREDIT PLATFORM_REVENUE (commission+bookingFee)` vs `DEBIT AGGREGATOR_CLEARING (total)`. On failure/timeout (120 s): trip payment converts to CASH (driver informed in-app; passenger pays cash) — never leave a trip in payment limbo.

**Webhooks:** signature verification, `idempotencyKey` unique constraint, store raw payload, respond 200 fast + process via queue. Nightly reconciliation job compares provider statement API (adapter method) against `AGGREGATOR_CLEARING` and flags mismatches to admin.

**Driver payout:** MVP = drivers keep cash fares, so payouts are rare (only when wallet is positive from mobile-money trips). Implement `PaymentProvider.disburse()` + admin-approved payout requests. No automatic payouts.

---

## 10. Realtime & notifications

- **Socket.io namespaces:** `/driver` (auth: driver JWT), `/passenger`, `/dispatch` (staff). Rooms per tripId. Redis adapter.
- **Every critical event goes out on 3 channels with fallback order:** socket (if connected) → FCM push → SMS. LATRA-required notifications (driver assigned/arrived, trip started, trip ended + fare) **always** send SMS regardless of socket state. Template all messages in Swahili with English fallback; templates live in DB (`sw`/`en` keys), not code.
- OTP: 6-digit, 5-min expiry, hashed at rest, max 5 attempts, resend rate-limited (1/min, 5/day per phone).
- Passenger without the app (dispatcher-created trip): entire trip lifecycle is SMS-driven — booking confirmation with driver name, plate, phone; arrival; receipt.

---

## 11. Maps & geo

- **OSRM** self-hosted (Docker, `car` profile is acceptable for all classes at MVP), Tanzania extract from Geofabrik, refresh script documented (monthly cron optional).
- **No geocoding API.** Pickup/destination selection = (a) GPS "my location", (b) map pin drag, (c) landmark search (Postgres trigram search over `Landmark.name` + aliases), (d) saved places.
- Web + driver app map: MapLibre with `TILE_URL` env var. Never call Google APIs.
- ETA display: OSRM duration × 1.2 traffic-naivety factor (config).

---

## 12. LATRA compliance module (`apps/api/src/latra`)

Build these now, with mocks where LATRA credentials are needed:
1. **Fare bounds enforcement** — see §8. Bounds are data, seeded with `VERIFY BEFORE LAUNCH` markers.
2. **Vehicle verification hook** — `LatraClient.verifyVehicle(plate, licenseNo)` interface + mock. Called during vehicle approval; admin can override with a logged justification while credentials are pending.
3. **Trip reporting outbox** — on COMPLETED/CANCELLED, enqueue `LatraReport` with trip payload (ids, plate, fare breakdown, distance, timestamps). `LatraClient` scaffold implements OAuth 2.0 client-credentials flow against configurable endpoints; retries with backoff; admin screen shows failed reports.
4. **In-app driver identity** — passenger trip screen must show driver name, photo, plate number, vehicle class (LATRA app-inspection requirement).
5. **E-receipt** — SMS + in-app receipt on completion with fare breakdown (also satisfies electronic-ticket requirement).

---

## 13. Applications — required screens/flows

### Passenger PWA (`apps/web`, mobile-first, Swahili default)
Onboarding (phone → OTP → name) · Home (map, pickup auto-GPS, destination via landmark/pin) · Vehicle class picker with fare estimate per class · Searching screen · Trip screen (driver card with photo/plate/phone `tel:` link, live driver marker, status) · Trip complete + rating · History with receipts · Saved places · Installable PWA (manifest + offline shell).

### Driver app (`apps/driver`, Expo, Android)
Login (phone OTP) · Onboarding checklist (documents upload, status) · Go Online/Offline toggle (blocked if wallet below limit or docs not APPROVED — show reason) · **Foreground service** for background GPS while online (persistent notification; use expo-task-manager/expo-location; document the required Android permissions incl. `ACCESS_BACKGROUND_LOCATION`) · Incoming offer full-screen (map, pickup distance, est. earnings, 25 s countdown, accept/decline; must surface from FCM when app is backgrounded) · Active trip (navigate button → deep link to installed maps app with coords, Arrived/Start/End buttons, cash amount to collect) · Wallet (balance, top-up via mobile money, transaction list) · Earnings summary (day/week) · Trip history.

### Admin + Dispatcher console (`apps/web`, desktop, role-gated)
**Dispatcher:** create trip for a caller (phone number, pickup landmark/pin, destination, class) → auto or manual dispatch · live map of online drivers · active trips board · cancel/reassign · waive cancellation fee.
**Admin:** driver onboarding queue (document review approve/reject with reasons, LATRA vehicle verification trigger) · users/drivers management (block, adjust wallet with mandatory memo → ledger entry) · fare config editor with LATRA-bounds validation and change history · ledger browser + reconciliation report · LATRA report status screen · support tickets · dashboards (trips/day, completion rate, cancellation rate, active drivers, revenue) · audit log viewer.

---

## 14. Security

- Argon2id for staff passwords; OTP hashed; JWTs RS256 with key rotation support.
- RBAC guards on every route; drivers can only read their own trips; passengers theirs.
- Rate limiting (Redis) on auth, OTP, trip creation; global sane defaults.
- Helmet-equivalent headers via Fastify; CORS locked to app origins; HTTPS enforced at proxy.
- All uploads (documents) to private object storage (S3-compatible env-configurable, e.g., Cloudflare R2); signed URLs; never public.
- PII: phone numbers masked in logs; audit log for every staff action; soft-delete users.
- Webhook endpoints verify provider signatures; replay-protected via idempotency keys.

---

## 15. Non-functional targets (design and test against these — no more)

- 300 concurrent online drivers, 60 concurrent active trips, 100 location msgs/sec.
- Dispatch decision (SEARCHING → first OFFERED) < 3 s p95.
- API p95 < 300 ms (excluding OSRM cold paths).
- Runs on a single 8 GB / 4 vCPU VPS with headroom.
- Data: nightly `pg_dump` to object storage, 30-day retention; Redis is rebuildable (no critical data lives only in Redis).
- Availability target 99.5% — no HA clustering; fast restart via Docker + health checks is acceptable.

---

## 16. Testing requirements (definition of done includes these)

- **Fare engine:** golden-file tests covering min-fare floor, rounding, commission split, cancellation fees, LATRA-bounds validation rejections.
- **State machine:** exhaustive transition-matrix tests (every from/to pair asserts allow/deny) + idempotency tests.
- **Dispatch:** integration tests with fake drivers in Redis — cascade on decline, offer timeout, lock contention (two trips, one driver), stale-driver exclusion.
- **Ledger:** every service method that writes money has a test asserting balanced txns; property test: random trip sequences keep ledger sum-zero.
- **Webhooks:** duplicate-delivery idempotency, bad-signature rejection.
- **E2E (Playwright):** passenger books → mock driver accepts → trip completes → receipt; dispatcher creates trip for phone caller.
- CI runs all of the above; no merge on red.

---

## 17. Deployment

- `docker-compose.prod.yml`: `caddy` (TLS + reverse proxy) · `api` · `web` · `postgres` · `redis` · `osrm` · `grafana`/`prometheus` (optional profile) · `backup` cron container.
- GitHub Actions: on tag → build images → push to registry → SSH deploy script (documented) with `prisma migrate deploy` and health-check gate.
- Seed script: admin user, fare configs (placeholder LATRA-compliant values), LatraBounds, Sumbawanga landmarks, one test driver/vehicle.
- Write `docs/RUNBOOK.md`: deploy, rollback, restore-from-backup, rotate JWT keys, refresh OSRM data, common incidents (Redis restart, aggregator webhook outage).

---

## 18. Build order (phases — complete and verify each before the next)

1. **Foundation:** monorepo, shared package (enums, Zod schemas, fare engine + tests), Prisma schema + migrations + seed, auth (OTP mock SMS), RBAC.
2. **Trip core:** state machine + TripService, dispatch engine with Redis, driver location ingestion, Socket.io, fake-driver simulator script (`scripts/sim-drivers.ts` — N virtual drivers that accept offers and replay GPS traces; needed for all later testing).
3. **Clients:** driver app (online/offer/trip flow with background location), passenger PWA (book/track/complete), SMS/FCM notification pipeline.
4. **Money:** ledger, cash commission flow, wallet, mock aggregator + adapter scaffold, receipts.
5. **Ops:** dispatcher console, admin (documents, fare config, ledger, dashboards), LATRA module, audit logs.
6. **Hardening:** observability, rate limits, E2E tests, docker prod, runbook, load test with simulator at NFR targets (k6 for HTTP, simulator for sockets).

---

## 19. Environment variables (document all in `.env.example`)

`DATABASE_URL, REDIS_URL, JWT_PRIVATE_KEY/PUBLIC_KEY, OTP_PEPPER, SMS_PROVIDER (mock|real), SMS_API_KEY, SMS_SENDER_ID, FCM_SERVICE_ACCOUNT_JSON, PAYMENT_PROVIDER (mock|real), PAYMENT_API_KEY/SECRET, PAYMENT_WEBHOOK_SECRET, OSRM_URL, TILE_URL, S3_ENDPOINT/KEY/SECRET/BUCKET, LATRA_OAUTH_URL, LATRA_API_URL, LATRA_CLIENT_ID/SECRET, SENTRY_DSN_(API|WEB|DRIVER), APP_BASE_URL, DEFAULT_LOCALE=sw`

---

## 20. Operator TODO (humans only — Claude Code must NOT fake these)

- [ ] Register company; apply for LATRA ride-hailing operator licence via **rrims.latra.go.tz** (requires certificate of incorporation etc.; LATRA officers will test the app — the §12 checklist maps to their inspection items).
- [ ] Obtain LATRA API + vehicle-verification credentials; **verify current LATRA fare bands and commission/booking-fee caps and update `LatraBounds` seed** before launch.
- [ ] Choose and contract a mobile-money aggregator (Selcom / AzamPay / ClickPesa or similar); obtain sandbox + prod credentials; implement/verify the real adapter against their docs.
- [ ] SMS: contract a provider covering TZ networks; register alphanumeric sender ID (TCRA process); load credentials.
- [ ] Google Play developer account; publish driver app (background-location permission requires a review justification video).
- [ ] VPS + domain + tile-provider key; Firebase project; Sentry project.
- [ ] Ground-truth the Sumbawanga landmark seed (coordinates + names).
- [ ] Insurance/legal review for driver contracts and passenger terms (sw + en).
- [ ] Recruit and document-verify initial driver cohort (target: 30+ bodaboda before launch — dispatch is useless below critical density).

---

*End of specification. When in doubt during implementation: smaller, boring, and testable beats clever. Do not add scope.*
