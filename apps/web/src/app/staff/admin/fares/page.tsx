"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Input } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface FareConfig {
  id: string;
  vehicleClass: string;
  active: boolean;
  baseFare: number;
  perKm: number;
  perMin: number;
  bookingFeePct: number;
  minimumFare: number;
  commissionPct: number;
  latraOrderRef: string;
  effectiveFrom: string;
}

interface Bounds {
  vehicleClass: string;
  minFareFloor: number;
  perKmMin: number;
  perKmMax: number;
  perMinMin: number;
  perMinMax: number;
  commissionMax: number;
  bookingFeeMax: number;
  sourceRef: string;
}

export default function FaresPage() {
  const [configs, setConfigs] = useState<FareConfig[]>([]);
  const [bounds, setBounds] = useState<Bounds[]>([]);
  const [editing, setEditing] = useState<FareConfig | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api<{ configs: FareConfig[]; bounds: Bounds[] }>("GET", "/admin/fares")
      .then((r) => {
        setConfigs(r.configs);
        setBounds(r.bounds);
      })
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  async function save() {
    if (!editing) return;
    setMessage(null);
    try {
      await api("POST", "/admin/fares", {
        vehicleClass: editing.vehicleClass,
        baseFare: editing.baseFare,
        perKm: editing.perKm,
        perMin: editing.perMin,
        bookingFeePct: editing.bookingFeePct,
        minimumFare: editing.minimumFare,
        commissionPct: editing.commissionPct,
        latraOrderRef: editing.latraOrderRef,
      });
      setMessage("Saved — new config active");
      setEditing(null);
      refresh();
    } catch (e) {
      // Bounds violations name the exact band violated (spec §8).
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  const active = configs.filter((c) => c.active);
  const history = configs.filter((c) => !c.active);
  const field = (label: string, key: keyof FareConfig) =>
    editing && (
      <label className="block text-sm">
        <span className="text-gray-500">{label}</span>
        <Input
          type="number"
          value={String(editing[key])}
          onChange={(e) => setEditing({ ...editing, [key]: Number(e.target.value) })}
        />
      </label>
    );

  return (
    <StaffShell>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 font-bold">Active fare configs</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2">Class</th>
                <th>Base</th>
                <th>/km</th>
                <th>/min</th>
                <th>Min</th>
                <th>Fee%</th>
                <th>Comm%</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="py-2 font-medium">{c.vehicleClass}</td>
                  <td>{c.baseFare}</td>
                  <td>{c.perKm}</td>
                  <td>{c.perMin}</td>
                  <td>{c.minimumFare}</td>
                  <td>{c.bookingFeePct}</td>
                  <td>{c.commissionPct}</td>
                  <td>
                    <button className="text-blue-600 underline" onClick={() => setEditing({ ...c })}>
                      edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="mb-1 mt-4 text-sm font-bold text-gray-500">LATRA bounds (VERIFY BEFORE LAUNCH)</h3>
          <table className="w-full text-xs text-gray-600">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1">Class</th>
                <th>Min floor</th>
                <th>/km band</th>
                <th>/min band</th>
                <th>Comm cap</th>
                <th>Fee cap</th>
              </tr>
            </thead>
            <tbody>
              {bounds.map((b) => (
                <tr key={b.vehicleClass} className="border-b">
                  <td className="py-1">{b.vehicleClass}</td>
                  <td>{b.minFareFloor}</td>
                  <td>{b.perKmMin}–{b.perKmMax}</td>
                  <td>{b.perMinMin}–{b.perMinMax}</td>
                  <td>{b.commissionMax}%</td>
                  <td>{b.bookingFeeMax}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          {editing ? (
            <>
              <h2 className="mb-2 font-bold">Edit {editing.vehicleClass}</h2>
              <div className="grid grid-cols-2 gap-2">
                {field("Base fare (TZS)", "baseFare")}
                {field("Per km (TZS)", "perKm")}
                {field("Per minute (TZS)", "perMin")}
                {field("Minimum fare (TZS)", "minimumFare")}
                {field("Booking fee (%)", "bookingFeePct")}
                {field("Commission (%)", "commissionPct")}
              </div>
              <label className="mt-2 block text-sm">
                <span className="text-gray-500">LATRA order reference</span>
                <Input
                  value={editing.latraOrderRef}
                  onChange={(e) => setEditing({ ...editing, latraOrderRef: e.target.value })}
                />
              </label>
              <div className="mt-3 flex gap-2">
                <Button onClick={() => void save()}>Save (validated against LATRA bounds)</Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-2 font-bold">Change history</h2>
              <div className="max-h-96 overflow-y-auto text-sm">
                {history.map((c) => (
                  <div key={c.id} className="border-b py-2 text-gray-600">
                    <span className="font-medium">{c.vehicleClass}</span> base {c.baseFare} · /km {c.perKm} · /min{" "}
                    {c.perMin} · min {c.minimumFare}
                    <span className="block text-xs text-gray-400">
                      {new Date(c.effectiveFrom).toLocaleString()} — {c.latraOrderRef}
                    </span>
                  </div>
                ))}
                {history.length === 0 && <p className="py-4 text-gray-400">No superseded configs yet.</p>}
              </div>
            </>
          )}
          {message && <p className="mt-3 text-sm text-red-600">{message}</p>}
        </Card>
      </div>
    </StaffShell>
  );
}
