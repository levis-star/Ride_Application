"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { t } from "@/lib/i18n";
import Map from "@/components/Map";
import { Card, Spinner } from "@/components/ui";

interface Shared {
  status: string;
  kind: string;
  vehicleClass: string;
  pickup: { lat: number; lng: number };
  drop: { lat: number; lng: number };
  driver?: { name: string; plateNumber: string; vehicleClass: string } | null;
  driverPosition?: { lat: number; lng: number } | null;
}

/**
 * Public share-my-trip view (Bolt-style). No login: the opaque token in the
 * URL is the capability. Polls the unauthenticated /public endpoint so a
 * family member can watch the vehicle move in real time.
 */
export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  const [trip, setTrip] = useState<Shared | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/public/trips/${token}`);
        if (!res.ok) throw new Error("not found");
        if (alive) setTrip((await res.json()) as Shared);
      } catch {
        if (alive) setNotFound(true);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [token]);

  if (notFound) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center text-gray-500">
        {t("track_not_found")}
      </main>
    );
  }
  if (!trip) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </main>
    );
  }

  const icon = trip.vehicleClass === "CAR" ? "🚗" : trip.vehicleClass === "BAJAJI" ? "🛺" : "🏍️";
  const markers = [
    { id: "pickup", ...trip.pickup, color: "#15803d", icon: "🟢" },
    { id: "drop", ...trip.drop, color: "#dc2626", icon: "📍" },
    ...(trip.driverPosition ? [{ id: "driver", ...trip.driverPosition, color: "#2563eb", icon }] : []),
  ];

  return (
    <main className="relative h-dvh">
      <div className="absolute inset-0">
        <Map center={trip.driverPosition ?? trip.pickup} markers={markers} />
      </div>
      <div className="absolute left-0 right-0 top-0 z-10 p-4">
        <Card>
          <p className="text-lg font-black text-brand-700">🔗 {t("track_title")}</p>
          <p className="mt-1 text-sm">
            {t("track_status")}: <span className="font-medium">{trip.status}</span>
          </p>
          {trip.driver && (
            <p className="mt-1 text-sm">
              {t("track_driver")}: <span className="font-medium">{trip.driver.name}</span> ·{" "}
              <span className="font-mono">{trip.driver.plateNumber}</span> {icon}
            </p>
          )}
        </Card>
      </div>
    </main>
  );
}
