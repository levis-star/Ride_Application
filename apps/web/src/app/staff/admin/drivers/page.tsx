"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, Input } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface DriverRow {
  id: string;
  name: string;
  phone: string;
  status: string;
  isBlocked: boolean;
  walletBalance: number;
  ratingAvg: number;
  strikeCount: number;
  manualAssignConsent: boolean;
  approvedAt: string | null;
  vehicle: { id: string; plateNumber: string; class: string; latraVerified: boolean } | null;
  documents: Array<{ id: string; type: string; status: string }>;
}

export default function DriversPage() {
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [q, setQ] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api<DriverRow[]>("GET", `/admin/drivers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setRows).catch(() => {});
  }, [q]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage(`${label}: OK`);
      refresh();
    } catch (e) {
      setMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Drivers</h2>
          <div className="w-64">
            <Input placeholder="Search name/phone…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {message && <span className="text-sm text-gray-500">{message}</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3">Driver</th>
                <th className="pr-3">Vehicle</th>
                <th className="pr-3">Status</th>
                <th className="pr-3">Wallet</th>
                <th className="pr-3">Rating</th>
                <th className="pr-3">Approved</th>
                <th className="pr-3">LATRA</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{d.name}</span>
                    <span className="block text-xs text-gray-400">{d.phone}</span>
                    {d.isBlocked && <span className="rounded bg-red-100 px-1 text-xs text-red-700">BLOCKED</span>}
                  </td>
                  <td className="pr-3">
                    {d.vehicle ? `${d.vehicle.plateNumber} (${d.vehicle.class})` : "—"}
                  </td>
                  <td className="pr-3 font-mono text-xs">{d.status}</td>
                  <td className="pr-3">TZS {d.walletBalance.toLocaleString()}</td>
                  <td className="pr-3">★ {d.ratingAvg.toFixed(1)} / {d.strikeCount} strikes</td>
                  <td className="pr-3">{d.approvedAt ? "✔" : "—"}</td>
                  <td className="pr-3">{d.vehicle?.latraVerified ? "✔" : "—"}</td>
                  <td className="space-x-1 whitespace-nowrap">
                    {!d.approvedAt && (
                      <button
                        className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => void act("Approve", () => api("POST", `/admin/drivers/${d.id}/approve`, {}))}
                      >
                        Approve
                      </button>
                    )}
                    {d.vehicle && !d.vehicle.latraVerified && (
                      <button
                        className="rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() =>
                          void act("LATRA verify", () => api("POST", `/admin/vehicles/${d.vehicle!.id}/verify`, {}))
                        }
                      >
                        LATRA verify
                      </button>
                    )}
                    <button
                      className="rounded bg-gray-600 px-2 py-1 text-xs font-semibold text-white"
                      onClick={() => {
                        const amount = Number(window.prompt("Adjust wallet by (TZS, negative to deduct):", "0"));
                        if (!amount) return;
                        const memo = window.prompt("Memo (required):");
                        if (!memo) return;
                        void act("Wallet adjust", () =>
                          api("POST", `/admin/drivers/${d.id}/wallet-adjust`, { amount, memo }),
                        );
                      }}
                    >
                      Wallet±
                    </button>
                    <button
                      className="rounded bg-purple-600 px-2 py-1 text-xs font-semibold text-white"
                      onClick={() =>
                        void act("Consent", () =>
                          api("POST", `/admin/drivers/${d.id}/consent`, { consent: !d.manualAssignConsent }),
                        )
                      }
                    >
                      {d.manualAssignConsent ? "Revoke consent" : "Grant consent"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </StaffShell>
  );
}
