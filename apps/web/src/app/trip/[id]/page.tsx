"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";
import { closePassengerSocket, passengerSocket } from "@/lib/socket";
import { t, TKey } from "@/lib/i18n";
import Map from "@/components/Map";
import TripSafetyBar from "@/components/TripSafetyBar";
import Receipt, { type ReceiptData } from "@/components/Receipt";
import { Button, Card, Sheet, Spinner, Stars } from "@/components/ui";

interface Snapshot {
  tripId: string;
  status: string;
  kind?: string;
  vehicleClass: string;
  pickup: { lat: number; lng: number };
  drop: { lat: number; lng: number };
  estimatedFare: number;
  finalFare?: number;
  recipient?: { name: string; phone: string };
  packageNote?: string;
  scheduledAt?: string;
  driver?: {
    id?: string;
    name: string;
    phone: string;
    plateNumber: string;
    vehicleClass: string;
    ratingAvg: number;
    photoUrl?: string;
  };
  receipt?: ReceiptData;
}

const SEARCHING_STATES = ["REQUESTED", "SEARCHING", "OFFERED"];

type LngLat = [number, number];

function haversineM(a: { lat: number; lng: number }, bLng: number, bLat: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - a.lat);
  const dLng = toRad(bLng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Nearest vertex index on the polyline to a position, + its distance (m). */
function nearestOnPath(path: LngLat[], pos: { lat: number; lng: number }): { idx: number; distM: number } {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = haversineM(pos, path[i][0], path[i][1]);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return { idx, distM: best };
}

/**
 * Bolt-style trailing route: keep only the part of the road ahead of the
 * driver — drop everything already travelled and start the line at the
 * driver's current position.
 */
function trimPath(full: LngLat[], pos: { lat: number; lng: number } | null): LngLat[] {
  if (!pos) return full;
  const { idx } = nearestOnPath(full, pos);
  return [[pos.lng, pos.lat], ...full.slice(idx + 1)];
}

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [driverPos, setDriverPos] = useState<{ lat: number; lng: number } | null>(null);
  const [route, setRoute] = useState<[number, number][] | undefined>(undefined);
  const [pickupEtaMin, setPickupEtaMin] = useState<number | null>(null);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);
  const [driverMsg, setDriverMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const legRef = useRef<{ key: string; full: [number, number][] } | null>(null);

  const refresh = useCallback(() => {
    void api<Snapshot>("GET", `/trips/${id}/snapshot`)
      .then(setSnap)
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    refresh();
    const socket = passengerSocket();
    socket.emit("trip:subscribe", { tripId: id }, (res: { ok: boolean; trip?: Snapshot }) => {
      if (res.ok && res.trip) setSnap(res.trip);
    });
    socket.on("trip:update", (u: Partial<Snapshot> & { tripId: string }) => {
      if (u.tripId === id) refresh();
    });
    socket.on("driver:location", (loc: { tripId: string; lat: number; lng: number }) => {
      if (loc.tripId === id) setDriverPos({ lat: loc.lat, lng: loc.lng });
    });
    socket.on("trip:message", (m: { tripId: string; message: string }) => {
      if (m.tripId !== id) return;
      const key = `msg_${m.message}` as TKey;
      setDriverMsg(`${t("from_driver")}: ${t(key)}`);
      setTimeout(() => setDriverMsg(null), 5000);
    });
    // Flaky-3G fallback: poll while the socket is down.
    pollRef.current = setInterval(() => {
      if (!socket.connected) refresh();
    }, 5000);
    return () => {
      socket.off("trip:update");
      socket.off("driver:location");
      socket.off("trip:message");
      clearInterval(pollRef.current);
      closePassengerSocket();
    };
  }, [id, refresh]);

  // Live green route for the current leg (driver→pickup, then →destination),
  // trimmed behind the driver so the line "trails" like Bolt/Uber. Fetches the
  // road geometry once per leg (and re-fetches only if the driver strays).
  useEffect(() => {
    if (!snap) return;
    const st = snap.status;
    let target: { lat: number; lng: number } | null = null;
    let key = "";
    if (st === "ACCEPTED" || st === "ARRIVED") {
      target = snap.pickup;
      key = "pickup";
    } else if (st === "IN_PROGRESS") {
      target = snap.drop;
      key = "drop";
    } else {
      legRef.current = null;
      setRoute(undefined);
      return;
    }
    const origin = driverPos ?? snap.pickup;
    const strayed =
      legRef.current?.key === key && driverPos
        ? nearestOnPath(legRef.current.full, driverPos).distM > 90
        : false;
    if (!legRef.current || legRef.current.key !== key || strayed) {
      const to = target;
      void api<{ geometry: LngLat[] | null; durationS: number }>("POST", "/routing/directions", { from: origin, to })
        .then((r) => {
          const full = r.geometry ?? [
            [origin.lng, origin.lat],
            [to.lng, to.lat],
          ];
          legRef.current = { key, full };
          setRoute(trimPath(full, driverPos));
          if (key === "pickup") setPickupEtaMin(Math.max(1, Math.round(r.durationS / 60)));
        })
        .catch(() => {});
    } else {
      setRoute(trimPath(legRef.current.full, driverPos));
    }
  }, [snap, driverPos]);

  // Driver photo (LATRA: rider sees the driver's photo). Fetched as an authed
  // blob because an <img src> would not carry the bearer token.
  useEffect(() => {
    const url = snap?.driver?.photoUrl;
    if (!url) {
      setPhotoSrc(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(`${API_URL}${url}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !cancelled) {
          objectUrl = URL.createObjectURL(b);
          setPhotoSrc(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [snap?.driver?.photoUrl]);

  if (!snap) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </main>
    );
  }

  const status = snap.status;
  const driverIcon =
    snap.vehicleClass === "CAR" ? "🚗" : snap.vehicleClass === "BAJAJI" ? "🛺" : "🏍️";
  // Once on board the passenger travels with the vehicle, so the stationary
  // pickup dot comes off the map — the vehicle icon is "you" (Bolt-style).
  const onBoard = status === "IN_PROGRESS";
  const markers = [
    ...(onBoard ? [] : [{ id: "pickup", ...snap.pickup, color: "#15803d", icon: "🟢" }]),
    { id: "drop", ...snap.drop, color: "#dc2626", icon: "📍" },
    ...(driverPos ? [{ id: "driver", ...driverPos, color: "#2563eb", icon: driverIcon }] : []),
  ];

  return (
    <main className="relative h-dvh">
      <div className="absolute inset-0">
        <Map center={driverPos ?? snap.pickup} markers={markers} route={route} />
      </div>

      {driverMsg && (
        <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full bg-brand-700 px-4 py-2 text-sm font-medium text-white shadow-lg">
          💬 {driverMsg}
        </div>
      )}

      {SEARCHING_STATES.includes(status) && (
        <Sheet>
          <Spinner />
          <p className="mt-3 text-center font-medium">{t("searching")}</p>
          <Button
            variant="danger"
            className="mt-4"
            onClick={() => void api("POST", `/trips/${id}/cancel`, {}).then(() => router.replace("/"))}
          >
            {t("cancel_trip")}
          </Button>
        </Sheet>
      )}

      {(status === "ACCEPTED" || status === "ARRIVED") && snap.driver && (
        <Sheet>
          <p className="text-center text-lg font-bold">
            {status === "ARRIVED" ? t("driver_arrived") : t("driver_coming")}
          </p>
          {status === "ACCEPTED" && pickupEtaMin !== null && (
            <p className="mt-1 text-center text-sm text-gray-500">~{pickupEtaMin} min</p>
          )}
          {/* LATRA in-app driver identity (spec §12.4): name, photo, plate, class. */}
          <Card className="mt-3 flex items-center gap-4 !bg-gray-50 !shadow-none">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-100 text-2xl">
              {photoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoSrc} alt={snap.driver.name} className="h-full w-full object-cover" />
              ) : snap.driver.vehicleClass === "CAR" ? (
                "🚗"
              ) : snap.driver.vehicleClass === "BAJAJI" ? (
                "🛺"
              ) : (
                "🏍️"
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{snap.driver.name}</p>
              <p className="font-mono text-sm">{snap.driver.plateNumber}</p>
              <p className="text-sm text-yellow-600">★ {snap.driver.ratingAvg.toFixed(1)}</p>
            </div>
          </Card>
          {snap.kind === "PARCEL" && snap.recipient && (
            <Card className="mt-3 !bg-amber-50 !shadow-none text-sm">
              📦 {t("to_recipient")}: <span className="font-medium">{snap.recipient.name}</span> ·{" "}
              <span className="font-mono">{snap.recipient.phone}</span>
              {snap.packageNote ? <div className="text-gray-500">{snap.packageNote}</div> : null}
            </Card>
          )}
          <a href={`tel:${snap.driver.phone}`} className="mt-3 block">
            <Button variant="outline">📞 {t("call_driver")}</Button>
          </a>
          <TripSafetyBar tripId={id} />
          <Button
            variant="danger"
            className="mt-2"
            onClick={() => void api("POST", `/trips/${id}/cancel`, {}).then(() => router.replace("/"))}
          >
            {t("cancel_trip")}
          </Button>
        </Sheet>
      )}

      {status === "IN_PROGRESS" && (
        <Sheet>
          <p className="text-center text-lg font-bold">{t("on_trip")}</p>
          <p className="mt-1 text-center text-sm text-gray-500">
            {t("est_fare")}: TZS {snap.estimatedFare.toLocaleString()}
          </p>
          <TripSafetyBar tripId={id} />
        </Sheet>
      )}

      {status === "COMPLETED" && (
        <Sheet>
          <p className="text-center text-lg font-bold">{t("trip_complete")}</p>
          <p className="mt-2 text-center text-3xl font-black text-brand-700">
            TZS {(snap.finalFare ?? snap.estimatedFare).toLocaleString()}
          </p>
          <p className="text-center text-sm text-gray-500">{t("pay_cash")}</p>
          {/* LATRA Stage-1 #10: full receipt right on completion, not only in history. */}
          {snap.receipt && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <Receipt {...snap.receipt} />
            </div>
          )}
          {!rated ? (
            <div className="mt-4">
              <p className="mb-2 text-center font-medium">{t("rate_driver")}</p>
              <Stars value={stars} onChange={setStars} />
              <Button
                className="mt-4"
                disabled={stars === 0}
                onClick={() =>
                  void api("POST", `/trips/${id}/rating`, { score: stars }).then(() => setRated(true))
                }
              >
                {t("submit_rating")}
              </Button>
            </div>
          ) : (
            <Button className="mt-4" onClick={() => router.replace("/")}>
              {t("home")}
            </Button>
          )}
        </Sheet>
      )}

      {(status === "EXPIRED" || status === "FAILED") && (
        <Sheet>
          <p className="text-center font-medium">{t("no_driver")}</p>
          <Button className="mt-4" onClick={() => router.replace("/")}>
            {t("retry")}
          </Button>
        </Sheet>
      )}

      {(status === "CANCELLED_BY_PASSENGER" || status === "CANCELLED_BY_DRIVER") && (
        <Sheet>
          <p className="text-center font-medium">{t("cancelled")}</p>
          <Button className="mt-4" onClick={() => router.replace("/")}>
            {t("home")}
          </Button>
        </Sheet>
      )}
    </main>
  );
}
