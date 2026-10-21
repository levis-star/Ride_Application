#!/usr/bin/env bash
# Launch RukwaRide as a public live demo over a free Cloudflare Tunnel.
#
#   - No SMS account: OTP runs in demo mode (code shown on the login screen).
#   - Same-origin: a local Caddy fronts web + API on :8080, so the tunnel needs
#     one hostname and cookies/CORS just work.
#   - Free & open-source: cloudflared quick tunnel (random https URL each run).
#
# Usage:  bash scripts/demo-live.sh            (start everything, print URL)
#         bash scripts/demo-live.sh stop       (tear the demo down)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="$HOME/.local/bin:$PATH"
SCRATCH="${SCRATCH:-/tmp/rukwaride-demo}"
mkdir -p "$SCRATCH"

stop() {
  echo "Stopping demo…"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  docker rm -f rukwaride-caddy 2>/dev/null || true
  pkill -f "sim-drivers.ts" 2>/dev/null || true
  pkill -f "dist/main.js" 2>/dev/null || true
  fuser -k 3000/tcp 2>/dev/null || true
  echo "Demo stopped (Postgres/Redis/OSRM containers left running; 'docker stop' them if you want)."
}
[ "${1:-}" = "stop" ] && { stop; exit 0; }

echo "==> 1/7 infra (Postgres, Redis, OSRM)…"
docker compose -f infra/docker-compose.yml up -d >/dev/null
docker start rukwaride-osrm >/dev/null 2>&1 || echo "   (OSRM container not found — run infra/osrm/setup.sh for road routing)"
until docker exec rukwaride-postgres pg_isready -U rukwaride >/dev/null 2>&1; do sleep 1; done

echo "==> 2/7 database migrate + seed…"
( cd apps/api && pnpm prisma migrate deploy >/dev/null 2>&1 && pnpm prisma:seed >/dev/null 2>&1 )

# A previous run killed mid-ride leaves trips/drivers ON_TRIP; such a driver
# refuses to go online and would poison the new fleet. Reset to a clean slate.
docker exec rukwaride-postgres psql -U rukwaride -d rukwaride -q -c \
  "UPDATE \"Trip\" SET status='FAILED', \"cancellationReason\"='demo restart'
     WHERE status IN ('REQUESTED','SEARCHING','OFFERED','ACCEPTED','ARRIVED','IN_PROGRESS');
   UPDATE \"DriverProfile\" SET status='OFFLINE' WHERE status <> 'OFFLINE';"
for p in 'driver:*' 'geo:drivers:*' 'lock:driver:*' 'trip:points:*'; do
  docker exec rukwaride-redis sh -c "redis-cli --scan --pattern '$p' | xargs -r redis-cli del" >/dev/null
done

echo "==> 3/7 API (build + demo-OTP mode)…"
pkill -f "dist/main.js" 2>/dev/null || true; sleep 1
pnpm --filter @rukwaride/api build >/dev/null 2>&1
( cd apps/api && setsid env AUTH_DEMO_MODE=true node --env-file=.env dist/main.js > "$SCRATCH/api.log" 2>&1 & )
until curl -sf localhost:3001/health >/dev/null 2>&1; do sleep 1; done

echo "==> 4/7 web (same-origin build)…"
# Kill by port: the running process is named "next-server", which a
# pkill -f "next start" misses — leaving a stale build bound to :3000.
fuser -k 3000/tcp 2>/dev/null || true; sleep 2
# Empty API base => web calls same origin; Caddy routes API paths to :3001.
( cd apps/web && NEXT_PUBLIC_API_URL="" pnpm build >/dev/null 2>&1 )
( cd apps/web && setsid env NEXT_PUBLIC_API_URL="" npx next start -p 3000 > "$SCRATCH/web.log" 2>&1 & )
until curl -sf localhost:3000/ >/dev/null 2>&1; do sleep 1; done

echo "==> 5/7 same-origin proxy (Caddy :8080)…"
docker rm -f rukwaride-caddy >/dev/null 2>&1 || true
docker run -d --name rukwaride-caddy --network host \
  -v "$ROOT/infra/caddy-demo/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
until curl -sf localhost:8080/health >/dev/null 2>&1; do sleep 1; done

echo "==> 6/7 driver fleet (8 road-following sim drivers)…"
pkill -f "sim-drivers.ts" 2>/dev/null || true
# --offset 10: the seed creates 20 sim drivers (0-19); this runs 8 of them
# (10-17) and keeps clear of the low identities the integration tests grab.
( cd scripts && setsid pnpm sim -- --drivers 8 --behavior accept --ping 2000 --speed 12 --offset 10 > "$SCRATCH/sim.log" 2>&1 & )

echo "==> 7/7 Cloudflare Tunnel…"
pkill -f "cloudflared tunnel" 2>/dev/null || true
setsid cloudflared tunnel --url http://localhost:8080 > "$SCRATCH/tunnel.log" 2>&1 &
URL=""
for i in $(seq 1 30); do
  # -a: cloudflared writes control bytes to its log, and without it grep says
  # "binary file matches" and prints nothing — the URL is found but discarded.
  URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$SCRATCH/tunnel.log" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

echo
echo "======================================================================"
if [ -n "$URL" ]; then
  echo "  RukwaRide is LIVE:  $URL"
  echo
  echo "  Passenger app:   $URL"
  echo "  Staff console:   $URL/staff/login"
  echo "     admin        +255700000001  /  ChangeMe123!"
  echo "     dispatcher   +255700000002  /  ChangeMe123!"
  echo
  echo "  Passenger login: enter any +255xxxxxxxxx — the OTP is shown on screen."
else
  echo "  Tunnel URL not detected yet — check $SCRATCH/tunnel.log"
fi
echo "  Logs: $SCRATCH/{api,web,sim,tunnel}.log"
echo "  Stop: bash scripts/demo-live.sh stop"
echo "======================================================================"
