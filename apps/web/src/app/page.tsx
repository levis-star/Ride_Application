"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, getToken } from "@/lib/api";
import { t } from "@/lib/i18n";
import Map, { DEFAULT_CENTER } from "@/components/Map";
import { Button, Card, Input, Sheet, Spinner } from "@/components/ui";

interface LatLng {
  lat: number;
  lng: number;
}
interface Landmark {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
}
interface Estimate {
  vehicleClass: "BODABODA" | "BAJAJI" | "CAR";
  fare: number;
}
interface NearbyDriver {
  vehicleClass: "BODABODA" | "BAJAJI" | "CAR";
  lat: number;
  lng: number;
  distanceM: number;
}

const CLASS_LABEL: Record<string, { icon: string; name: string }> = {
  BODABODA: { icon: "🏍️", name: "Bodaboda" },
  BAJAJI: { icon: "🛺", name: "Bajaji" },
  CAR: { icon: "🚗", name: "Gari" },
};

type Phase = "dest" | "pin" | "class" | "booking";

export default function HomePage() {
  const router = useRouter();
  const [pickup, setPickup] = useState<LatLng>(DEFAULT_CENTER);
  const [gpsLocked, setGpsLocked] = useState(false);
  const [phase, setPhase] = useState<Phase>("dest");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Landmark[]>([]);
  const [drop, setDrop] = useState<(LatLng & { label: string; landmarkId?: string }) | null>(null);
  const [pinCenter, setPinCenter] = useState<LatLng>(DEFAULT_CENTER);
  const [estimates, setEstimates] = useState<Estimate[] | null>(null);
  const [distanceM, setDistanceM] = useState(0);
  const [selectedClass, setSelectedClass] = useState<string>("BODABODA");
  // Rider-feature options on the booking sheet (Bolt/Uber parity).
  const [tripKind, setTripKind] = useState<"RIDE" | "PARCEL">("RIDE");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("+255");
  const [packageNote, setPackageNote] = useState("");
  const [scheduledAt, setScheduledAt] = useState(""); // datetime-local; "" = book now
  const [nearby, setNearby] = useState<NearbyDriver[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [route, setRoute] = useState<[number, number][] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hidden staff entrance: 5 quick taps on the brand dot → /staff/login.
  const staffTapsRef = useRef<number[]>([]);
  function brandDotTap() {
    const now = Date.now();
    staffTapsRef.current = [...staffTapsRef.current.filter((t0) => now - t0 < 3000), now];
    if (staffTapsRef.current.length >= 5) {
      staffTapsRef.current = [];
      router.push("/staff/login");
    }
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    // Resume an active trip if one exists (reload/reconnect tolerance).
    void api<Array<{ id: string; status: string }>>("GET", "/trips").then((trips) => {
      const active = trips.find((x) =>
        ["REQUESTED", "SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"].includes(x.status),
      );
      if (active) router.replace(`/trip/${active.id}`);
    });
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setPickup({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLocked(true);
      },
      () => undefined,
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [router]);

  useEffect(() => {
    if (phase !== "dest") return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void api<Landmark[]>("GET", `/landmarks?q=${encodeURIComponent(query)}`).then(setResults).catch(() => {});
    }, 250);
  }, [query, phase]);

  // Live "drivers near you" while choosing a destination (spec §13).
  useEffect(() => {
    if (phase === "booking") return;
    const poll = () => {
      void api<{ drivers: NearbyDriver[]; countByClass: Record<string, number> }>(
        "GET",
        `/drivers/nearby?lat=${pickup.lat}&lng=${pickup.lng}`,
      )
        .then((r) => {
          setNearby(r.drivers);
          setCounts(r.countByClass);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [pickup.lat, pickup.lng, phase]);

  async function chooseDrop(target: LatLng & { label: string; landmarkId?: string }) {
    setDrop(target);
    setPhase("class");
    setEstimates(null);
    setError(null);
    try {
      const res = await api<{
        distanceM: number;
        geometry: [number, number][] | null;
        estimates: Estimate[];
      }>("POST", "/trips/estimate", {
        pickup: { lat: pickup.lat, lng: pickup.lng },
        drop: { lat: target.lat, lng: target.lng },
      });
      setEstimates(res.estimates);
      setDistanceM(res.distanceM);
      setRoute(res.geometry ?? undefined); // road polyline drawn on the map
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("dest");
    }
  }

  async function book() {
    if (!drop) return;
    if (tripKind === "PARCEL" && (recipientName.trim().length < 2 || recipientPhone.length < 10)) {
      setError(t("recipient_name"));
      return;
    }
    setPhase("booking");
    setError(null);
    try {
      const trip = await api<{ id: string; status: string }>("POST", "/trips", {
        vehicleClass: selectedClass,
        kind: tripKind,
        pickup: { lat: pickup.lat, lng: pickup.lng },
        drop: { lat: drop.lat, lng: drop.lng, landmarkId: drop.landmarkId },
        paymentMethod: "CASH",
        ...(tripKind === "PARCEL"
          ? { recipient: { name: recipientName.trim(), phone: recipientPhone }, packageNote: packageNote.trim() || undefined }
          : {}),
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      });
      // Scheduled trips have no live screen yet — confirm and return home.
      if (trip.status === "SCHEDULED") {
        alert(`${t("scheduled_ok")} — ${new Date(scheduledAt).toLocaleString()}`);
        router.push("/history");
      } else {
        router.push(`/trip/${trip.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("class");
    }
  }

  // Nearby driver markers (vehicle emoji) are shown while choosing; once a
  // destination is picked we focus on the pickup/drop + route.
  const showNearby = phase === "dest" || phase === "pin";
  const markers = [
    { id: "pickup", ...pickup, color: "#15803d", icon: "🟢", label: t("pickup") },
    ...(drop ? [{ id: "drop", lat: drop.lat, lng: drop.lng, color: "#dc2626", icon: "📍", label: drop.label }] : []),
    ...(showNearby
      ? nearby.map((d, i) => ({
          id: `drv-${i}`,
          lat: d.lat,
          lng: d.lng,
          color: "#111827",
          icon: CLASS_LABEL[d.vehicleClass]?.icon ?? "🚗",
        }))
      : []),
  ];
  const nearbyTotal = nearby.length;

  return (
    <main className="relative h-dvh">
      <div className="absolute inset-0">
        <Map
          center={phase === "pin" ? pinCenter : pickup}
          markers={phase === "pin" ? [] : markers}
          route={showNearby ? undefined : route}
          onMoveEnd={(c) => phase === "pin" && setPinCenter(c)}
        />
      </div>

      {/* fixed centre pin in pin-drop mode */}
      {phase === "pin" && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-full text-4xl">
          📍
        </div>
      )}

      <div className="absolute left-0 right-0 top-0 z-10 p-4">
        <Card className="flex items-center gap-2 !py-3">
          <span role="presentation" onClick={brandDotTap} className="-m-2 shrink-0 p-2">
            <span className="block h-3 w-3 rounded-full bg-brand-600" />
          </span>
          <div className="truncate text-sm">
            <span className="text-gray-400">{t("pickup")}: </span>
            <span className="font-medium">{gpsLocked ? t("my_location") : "Sumbawanga"}</span>
          </div>
          <a href="/history" className="ml-auto shrink-0 text-xl" aria-label={t("history")}>
            🕓
          </a>
        </Card>
      </div>

      {phase === "dest" && (
        <Sheet>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-lg font-bold">{t("destination")}</h2>
            <span className="ml-auto rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
              {nearbyTotal > 0 ? (
                <>
                  {(["BODABODA", "BAJAJI", "CAR"] as const)
                    .filter((c) => (counts[c] ?? 0) > 0)
                    .map((c) => `${CLASS_LABEL[c].icon} ${counts[c]}`)
                    .join("  ")}{" "}
                  {t("drivers_nearby")}
                </>
              ) : (
                t("no_drivers_nearby")
              )}
            </span>
          </div>
          <Input placeholder={t("search_landmark")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="mt-2 max-h-56 overflow-y-auto">
            {results.map((l) => (
              <button
                key={l.id}
                className="flex w-full items-center gap-3 border-b border-gray-100 px-1 py-3 text-left active:bg-gray-50"
                onClick={() => void chooseDrop({ lat: l.lat, lng: l.lng, label: l.name, landmarkId: l.id })}
              >
                <span>📌</span>
                <span>
                  <span className="block font-medium">{l.name}</span>
                  <span className="block text-xs text-gray-400">{l.category}</span>
                </span>
              </button>
            ))}
          </div>
          <Button variant="outline" className="mt-3" onClick={() => setPhase("pin")}>
            🗺️ {t("drop_pin")}
          </Button>
          <a href="/driver" className="mt-3 block text-center text-sm text-gray-400 underline">
            🛵 {t("become_driver")}
          </a>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Sheet>
      )}

      {phase === "pin" && (
        <Sheet>
          <Button onClick={() => void chooseDrop({ ...pinCenter, label: "Pini" })}>{t("confirm_pin")}</Button>
          <Button variant="ghost" className="mt-2" onClick={() => setPhase("dest")}>
            ←
          </Button>
        </Sheet>
      )}

      {(phase === "class" || phase === "booking") && (
        <Sheet>
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-lg font-bold">{drop?.label}</h2>
            <span className="text-sm text-gray-500">{(distanceM / 1000).toFixed(1)} km</span>
          </div>
          <p className="mb-3 text-xs text-gray-400">{t("estimate_note")}</p>
          {!estimates && <Spinner />}
          {estimates && (
            <div className="space-y-2">
              {estimates.map((e) => (
                <button
                  key={e.vehicleClass}
                  onClick={() => setSelectedClass(e.vehicleClass)}
                  className={`flex w-full items-center justify-between rounded-xl border-2 px-4 py-3 ${
                    selectedClass === e.vehicleClass ? "border-brand-600 bg-brand-50" : "border-gray-200"
                  }`}
                >
                  <span className="flex items-center gap-3 font-medium">
                    <span className="text-2xl">{CLASS_LABEL[e.vehicleClass]?.icon}</span>
                    {CLASS_LABEL[e.vehicleClass]?.name}
                  </span>
                  <span className="font-bold">TZS {e.fare.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
          {/* Ride vs parcel courier */}
          <div className="mt-3 flex gap-2">
            {(["RIDE", "PARCEL"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTripKind(k)}
                className={`flex-1 rounded-lg border-2 py-2 text-sm font-medium ${
                  tripKind === k ? "border-brand-600 bg-brand-50" : "border-gray-200"
                }`}
              >
                {k === "RIDE" ? `🧍 ${t("ride")}` : `📦 ${t("parcel")}`}
              </button>
            ))}
          </div>

          {tripKind === "PARCEL" && (
            <div className="mt-2 space-y-2">
              <Input placeholder={t("recipient_name")} value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
              <Input
                placeholder={t("recipient_phone")}
                inputMode="tel"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value.replace(/[^+\d]/g, ""))}
              />
              <Input placeholder={t("package_note")} value={packageNote} onChange={(e) => setPackageNote(e.target.value)} />
            </div>
          )}

          {/* Book now vs schedule */}
          <div className="mt-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              🕒 {t("book_later")}
              <input
                type="datetime-local"
                className="ml-auto rounded-lg border border-gray-300 px-2 py-1 text-sm"
                value={scheduledAt}
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </label>
          </div>

          <Button className="mt-4" onClick={() => void book()} disabled={!estimates || phase === "booking"}>
            {phase === "booking" ? "…" : scheduledAt ? t("book_later") : t("book_now")}
          </Button>
          <Button variant="ghost" className="mt-1" onClick={() => setPhase("dest")}>
            ←
          </Button>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Sheet>
      )}
    </main>
  );
}
