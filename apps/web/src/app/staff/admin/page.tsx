"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import StaffShell from "../StaffShell";

interface Dashboard {
  tripsToday: number;
  trips7d: number;
  completionRate7d: number | null;
  cancellationRate7d: number | null;
  expiredRate7d: number | null;
  activeDriversNow: number;
  revenue7d: number;
  openTickets: number;
  failedLatraReports: number;
}

function Stat({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <Card className={alert ? "border-2 border-red-400" : ""}>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`text-3xl font-black ${alert ? "text-red-600" : "text-gray-900"}`}>{value}</p>
    </Card>
  );
}

interface FleetCounts {
  [cls: string]: { registered: number; approved: number; online: number; available: number };
}

const VEHICLE_ICON: Record<string, string> = { BODABODA: "🏍️", BAJAJI: "🛺", CAR: "🚗" };
const VEHICLE_NAME: Record<string, string> = { BODABODA: "Bodaboda", BAJAJI: "Bajaji", CAR: "Gari" };

export default function AdminDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [fleet, setFleet] = useState<FleetCounts | null>(null);

  useEffect(() => {
    const load = () => {
      void api<Dashboard>("GET", "/admin/dashboard").then(setData).catch(() => {});
      void api<FleetCounts>("GET", "/admin/fleet").then(setFleet).catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <StaffShell>
      {data && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <Stat label="Trips today" value={data.tripsToday} />
          <Stat label="Trips (7d)" value={data.trips7d} />
          <Stat label="Completion rate (7d)" value={pct(data.completionRate7d)} />
          <Stat label="Cancellation rate (7d)" value={pct(data.cancellationRate7d)} />
          <Stat label="Expired rate (7d)" value={pct(data.expiredRate7d)} />
          <Stat label="Active drivers now" value={data.activeDriversNow} />
          <Stat label="Revenue 7d (TZS)" value={data.revenue7d.toLocaleString()} />
          <Stat label="Open tickets" value={data.openTickets} alert={data.openTickets > 0} />
          <Stat label="Failed LATRA reports" value={data.failedLatraReports} alert={data.failedLatraReports > 0} />
        </div>
      )}

      {/* Fleet by vehicle class — registration + live availability (spec §1). */}
      {fleet && (
        <div className="mt-6">
          <h2 className="mb-3 text-lg font-bold text-gray-800">Fleet by vehicle class</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {(["BODABODA", "BAJAJI", "CAR"] as const).map((cls) => {
              const f = fleet[cls] ?? { registered: 0, approved: 0, online: 0, available: 0 };
              return (
                <Card key={cls}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-2xl">{VEHICLE_ICON[cls]}</span>
                    <span className="text-lg font-bold">{VEHICLE_NAME[cls]}</span>
                    <span className="ml-auto rounded-full bg-brand-100 px-3 py-1 text-sm font-semibold text-brand-700">
                      {f.available} available now
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <div>
                      <p className="text-2xl font-black">{f.registered}</p>
                      <p className="text-gray-500">registered</p>
                    </div>
                    <div>
                      <p className="text-2xl font-black">{f.approved}</p>
                      <p className="text-gray-500">approved</p>
                    </div>
                    <div>
                      <p className="text-2xl font-black text-blue-600">{f.online}</p>
                      <p className="text-gray-500">online</p>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="mt-2 text-sm text-gray-500">
            Per-area distribution is on the{" "}
            <a href="/staff/dispatch" className="text-brand-700 underline">
              live dispatch map
            </a>
            .
          </p>
        </div>
      )}
    </StaffShell>
  );
}
