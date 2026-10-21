"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import Map, { DEFAULT_CENTER } from "@/components/Map";
import { Button, Card, Input } from "@/components/ui";
import StaffShell from "../StaffShell";

interface OnlineDriver {
  driverProfileId: string;
  name: string;
  plateNumber?: string;
  vehicleClass?: string;
  status: string;
  lat: number | null;
  lng: number | null;
  manualAssignConsent: boolean;
  lastPingAgoS: number | null;
}

interface BoardTrip {
  id: string;
  status: string;
  vehicleClass: string;
  source: string;
  createdAt: string;
  passenger: { name?: string; phone?: string | null };
  driver: { id: string; name: string; phone: string } | null;
  pickup: { lat: number; lng: number; label?: string };
  drop: { lat: number; lng: number; label?: string };
  estimatedFare: number;
  offeredCount: number;
  cancellationFee: number | null;
}

interface Landmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface SosAlert {
  id: string;
  tripId: string;
  status: string;
  raisedByRole: string;
  raisedByName: string;
  raisedByPhone: string;
  lat: number | null;
  lng: number | null;
  note: string | null;
  createdAt: string;
  driver?: { name: string; phone: string; plateNumber: string } | null;
}

const STATUS_COLOR: Record<string, string> = {
  AVAILABLE: "#16a34a",
  ON_OFFER: "#f59e0b",
  ON_TRIP: "#2563eb",
};

export default function DispatchPage() {
  const [drivers, setDrivers] = useState<OnlineDriver[]>([]);
  const [trips, setTrips] = useState<BoardTrip[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // create-trip form (phone caller — spec §1: dispatcher is first-class)
  const [phone, setPhone] = useState("+255");
  const [callerName, setCallerName] = useState("");
  const [vehicleClass, setVehicleClass] = useState("BODABODA");
  const [pickupQuery, setPickupQuery] = useState("");
  const [dropQuery, setDropQuery] = useState("");
  const [pickupOptions, setPickupOptions] = useState<Landmark[]>([]);
  const [dropOptions, setDropOptions] = useState<Landmark[]>([]);
  const [pickup, setPickup] = useState<Landmark | null>(null);
  const [drop, setDrop] = useState<Landmark | null>(null);
  const [busy, setBusy] = useState(false);
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [d, t, s] = await Promise.all([
        api<OnlineDriver[]>("GET", "/dispatch/drivers/online"),
        api<BoardTrip[]>("GET", "/dispatch/trips/active"),
        api<SosAlert[]>("GET", "/dispatch/sos-alerts"),
      ]);
      setDrivers(d);
      setTrips(t);
      setSosAlerts(s);
    } catch {
      /* transient */
    }
  }, []);

  async function sosAction(id: string, action: "ack" | "resolve") {
    await api("POST", `/dispatch/sos-alerts/${id}/${action}`, {}).catch(() => {});
    await refresh();
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000); // live map/board poll
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (pickupQuery.length > 1)
        void api<Landmark[]>("GET", `/landmarks?q=${encodeURIComponent(pickupQuery)}`).then(setPickupOptions);
    }, 250);
    return () => clearTimeout(t);
  }, [pickupQuery]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (dropQuery.length > 1)
        void api<Landmark[]>("GET", `/landmarks?q=${encodeURIComponent(dropQuery)}`).then(setDropOptions);
    }, 250);
    return () => clearTimeout(t);
  }, [dropQuery]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage(`${label}: OK`);
      await refresh();
    } catch (e) {
      setMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function createTrip() {
    if (!pickup || !drop) return;
    setBusy(true);
    await act("Create trip", () =>
      api("POST", "/trips", {
        vehicleClass,
        pickup: { lat: pickup.lat, lng: pickup.lng, landmarkId: pickup.id },
        drop: { lat: drop.lat, lng: drop.lng, landmarkId: drop.id },
        paymentMethod: "CASH",
        contactPhone: phone,
        contactName: callerName.trim() || undefined,
      }),
    );
    setBusy(false);
  }

  const VEHICLE_ICON: Record<string, string> = { BODABODA: "🏍️", BAJAJI: "🛺", CAR: "🚗" };
  const markers = drivers
    .filter((d) => d.lat !== null)
    .map((d) => ({
      id: d.driverProfileId,
      lat: d.lat!,
      lng: d.lng!,
      color: STATUS_COLOR[d.status] ?? "#6b7280",
      icon: VEHICLE_ICON[d.vehicleClass ?? ""] ?? "🚗",
      label: `${d.name} · ${d.status}`,
    }));

  return (
    <StaffShell>
      {sosAlerts.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-red-500 bg-red-50 p-4">
          <h2 className="mb-2 flex items-center gap-2 font-bold text-red-700">
            🆘 Emergency alerts ({sosAlerts.length})
          </h2>
          <div className="space-y-2">
            {sosAlerts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white p-3 text-sm">
                <span className={`rounded px-2 py-0.5 text-xs font-bold ${a.status === "OPEN" ? "bg-red-600 text-white" : "bg-amber-500 text-white"}`}>
                  {a.status}
                </span>
                <span className="font-medium">{a.raisedByRole}</span>
                <a href={`tel:${a.raisedByPhone}`} className="font-mono text-blue-600 underline">{a.raisedByPhone}</a>
                {a.driver && <span className="text-gray-600">driver {a.driver.name} · {a.driver.plateNumber}</span>}
                {a.lat && a.lng && (
                  <a
                    href={`https://www.google.com/maps?q=${a.lat},${a.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 underline"
                  >
                    📍 location
                  </a>
                )}
                {a.note && <span className="text-gray-500">“{a.note}”</span>}
                <span className="ml-auto flex gap-1">
                  {a.status === "OPEN" && (
                    <button className="rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-white" onClick={() => void sosAction(a.id, "ack")}>
                      Acknowledge
                    </button>
                  )}
                  <button className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => void sosAction(a.id, "resolve")}>
                    Resolve
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Create trip for a phone caller */}
        <Card>
          <h2 className="mb-3 font-bold">New trip (phone caller)</h2>
          <div className="space-y-2">
            <Input placeholder="Caller name (LATRA)" value={callerName} onChange={(e) => setCallerName(e.target.value)} />
            <Input placeholder="Caller phone +255…" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^+\d]/g, ""))} />
            <select
              className="w-full rounded-xl border border-gray-300 px-4 py-3"
              value={vehicleClass}
              onChange={(e) => setVehicleClass(e.target.value)}
            >
              <option value="BODABODA">Bodaboda</option>
              <option value="BAJAJI">Bajaji</option>
              <option value="CAR">Gari</option>
            </select>
            <div>
              <Input
                placeholder={pickup ? `Pickup: ${pickup.name}` : "Pickup landmark…"}
                value={pickupQuery}
                onChange={(e) => setPickupQuery(e.target.value)}
              />
              {pickupOptions.length > 0 && pickupQuery && (
                <div className="mt-1 rounded-lg border border-gray-200 bg-white">
                  {pickupOptions.map((l) => (
                    <button
                      key={l.id}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setPickup(l);
                        setPickupQuery("");
                        setPickupOptions([]);
                      }}
                    >
                      {l.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Input
                placeholder={drop ? `Destination: ${drop.name}` : "Destination landmark…"}
                value={dropQuery}
                onChange={(e) => setDropQuery(e.target.value)}
              />
              {dropOptions.length > 0 && dropQuery && (
                <div className="mt-1 rounded-lg border border-gray-200 bg-white">
                  {dropOptions.map((l) => (
                    <button
                      key={l.id}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                      onClick={() => {
                        setDrop(l);
                        setDropQuery("");
                        setDropOptions([]);
                      }}
                    >
                      {l.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button onClick={() => void createTrip()} disabled={busy || !pickup || !drop || phone.length < 10}>
              Book & auto-dispatch
            </Button>
          </div>
          {message && <p className="mt-2 text-sm text-gray-600">{message}</p>}
        </Card>

        {/* Live driver map */}
        <Card className="lg:col-span-2">
          <h2 className="mb-2 font-bold">
            Online drivers <span className="text-sm font-normal text-gray-500">({drivers.length})</span>
          </h2>
          <div className="h-72 overflow-hidden rounded-xl">
            <Map center={DEFAULT_CENTER} markers={markers} />
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto text-sm">
            {drivers.map((d) => (
              <div key={d.driverProfileId} className="flex items-center gap-2 border-b border-gray-100 py-1">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[d.status] ?? "#6b7280" }} />
                <span className="font-medium">{d.name}</span>
                <span className="text-gray-400">{d.plateNumber} · {d.vehicleClass} · {d.status}</span>
                {d.manualAssignConsent && <span className="rounded bg-brand-100 px-1 text-xs text-brand-700">consent</span>}
                <span className="ml-auto text-xs text-gray-400">{d.lastPingAgoS}s ago</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Active trips board */}
        <Card className="lg:col-span-3">
          <h2 className="mb-2 font-bold">
            Active trips <span className="text-sm font-normal text-gray-500">({trips.length})</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">Status</th>
                  <th className="pr-3">Passenger</th>
                  <th className="pr-3">Route</th>
                  <th className="pr-3">Class</th>
                  <th className="pr-3">Driver</th>
                  <th className="pr-3">Fare est.</th>
                  <th className="pr-3">Assign to</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <TripRow key={t.id} trip={t} drivers={drivers} onAction={act} />
                ))}
                {trips.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-gray-400">
                      No active trips
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </StaffShell>
  );
}

function TripRow({
  trip,
  drivers,
  onAction,
}: {
  trip: BoardTrip;
  drivers: OnlineDriver[];
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [assignee, setAssignee] = useState("");
  const eligible = drivers.filter((d) => d.status === "AVAILABLE" && d.vehicleClass === trip.vehicleClass);
  const consented = drivers.find((d) => d.driverProfileId === assignee)?.manualAssignConsent;

  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 font-mono text-xs">{trip.status}</td>
      <td className="pr-3">{trip.passenger.name || trip.passenger.phone || "—"}</td>
      <td className="pr-3 text-xs text-gray-500">
        {trip.pickup.label ?? `${trip.pickup.lat.toFixed(3)},${trip.pickup.lng.toFixed(3)}`} →{" "}
        {trip.drop.label ?? `${trip.drop.lat.toFixed(3)},${trip.drop.lng.toFixed(3)}`}
      </td>
      <td className="pr-3">{trip.vehicleClass}</td>
      <td className="pr-3">{trip.driver?.name ?? <span className="text-gray-400">searching ({trip.offeredCount})</span>}</td>
      <td className="pr-3">TZS {trip.estimatedFare.toLocaleString()}</td>
      <td className="pr-3">
        {trip.status === "SEARCHING" ? (
          <select
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">— driver —</option>
            {eligible.map((d) => (
              <option key={d.driverProfileId} value={d.driverProfileId}>
                {d.name} ({d.plateNumber})
              </option>
            ))}
          </select>
        ) : (
          "—"
        )}
      </td>
      <td className="space-x-1 whitespace-nowrap">
        {trip.status === "SEARCHING" && assignee && (
          <>
            <button
              className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
              onClick={() =>
                void onAction("Offer", () =>
                  api("POST", `/dispatch/trips/${trip.id}/assign`, { driverProfileId: assignee, force: false }),
                )
              }
            >
              Offer 60s
            </button>
            {consented && (
              <button
                className="rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white"
                onClick={() =>
                  void onAction("Force-assign", () =>
                    api("POST", `/dispatch/trips/${trip.id}/assign`, { driverProfileId: assignee, force: true }),
                  )
                }
              >
                Force
              </button>
            )}
          </>
        )}
        {["OFFERED", "ACCEPTED", "ARRIVED"].includes(trip.status) && (
          <button
            className="rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-white"
            onClick={() => void onAction("Reassign", () => api("POST", `/dispatch/trips/${trip.id}/reassign`, {}))}
          >
            Reassign
          </button>
        )}
        <button
          className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white"
          onClick={() =>
            void onAction("Cancel", () => api("POST", `/trips/${trip.id}/cancel`, { reason: "Dispatcher cancel" }))
          }
        >
          Cancel
        </button>
        {trip.cancellationFee !== null && trip.cancellationFee > 0 && (
          <button
            className="rounded bg-gray-500 px-2 py-1 text-xs font-semibold text-white"
            onClick={() => void onAction("Waive fee", () => api("POST", `/dispatch/trips/${trip.id}/waive-fee`, {}))}
          >
            Waive fee
          </button>
        )}
      </td>
    </tr>
  );
}
