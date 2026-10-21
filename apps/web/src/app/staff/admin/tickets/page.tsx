"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface Ticket {
  id: string;
  category: string;
  body: string;
  status: string;
  resolutionNote: string | null;
  tripId: string | null;
  createdAt: string;
  openedBy: { name: string; phone: string };
}

export default function TicketsPage() {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [status, setStatus] = useState("OPEN");

  const refresh = useCallback(() => {
    void api<Ticket[]>("GET", `/admin/tickets${status ? `?status=${status}` : ""}`).then(setRows).catch(() => {});
  }, [status]);

  useEffect(refresh, [refresh]);

  async function resolve(id: string) {
    const note = window.prompt("Resolution note:");
    if (!note) return;
    await api("POST", `/admin/tickets/${id}`, { status: "RESOLVED", resolutionNote: note });
    refresh();
  }

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Support tickets</h2>
          <select
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {rows.map((t) => (
            <div key={t.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold">{t.category}</span>
                <span className="text-gray-400">
                  {t.openedBy.name} ({t.openedBy.phone}) · {new Date(t.createdAt).toLocaleString()}
                </span>
                <span className="ml-auto rounded bg-gray-100 px-2 text-xs">{t.status}</span>
                {t.status !== "RESOLVED" && t.status !== "CLOSED" && (
                  <button
                    className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                    onClick={() => void resolve(t.id)}
                  >
                    Resolve
                  </button>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-700">{t.body}</p>
              {t.resolutionNote && <p className="mt-1 text-xs text-brand-700">Resolution: {t.resolutionNote}</p>}
            </div>
          ))}
          {rows.length === 0 && <p className="py-6 text-center text-gray-400">No tickets</p>}
        </div>
      </Card>
    </StaffShell>
  );
}
