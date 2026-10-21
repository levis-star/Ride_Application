"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface Report {
  id: string;
  tripId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface DailyReport {
  id: string;
  reportDate: string;
  totalTrip: number;
  totalPaidAmount: number;
  status: string;
  attempts: number;
  lastError: string | null;
  submittedAt: string | null;
}

interface RegistrationIssues {
  drivers: Array<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
    licenseNumber: string | null;
    licenceCategory: string | null;
    error: string | null;
  }>;
  vehicles: Array<{ id: string; plateNumber: string; class: string; error: string | null }>;
}

const BADGE: Record<string, string> = {
  ACKED: "bg-brand-100 text-brand-700",
  PENDING: "bg-amber-100 text-amber-700",
  SENT: "bg-blue-100 text-blue-700",
  FAILED: "bg-red-100 text-red-700",
};

export default function LatraPage() {
  const [rows, setRows] = useState<Report[]>([]);
  const [daily, setDaily] = useState<DailyReport[]>([]);
  const [issues, setIssues] = useState<RegistrationIssues>({ drivers: [], vehicles: [] });
  const [status, setStatus] = useState("");

  const refresh = useCallback(() => {
    void api<Report[]>("GET", `/admin/latra-reports${status ? `?status=${status}` : ""}`).then(setRows).catch(() => {});
    void api<DailyReport[]>("GET", "/admin/latra-daily-reports").then(setDaily).catch(() => {});
    void api<RegistrationIssues>("GET", "/admin/latra-registration-issues").then(setIssues).catch(() => {});
  }, [status]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const unregistered = issues.drivers.length + issues.vehicles.length;

  return (
    <StaffShell>
      {/* A trip may only reference a driver and vehicle LATRA has already
          accepted, so anything listed here is a driver whose trips cannot be
          reported at all. Surfaced first because it is the most damaging
          failure and used to be invisible. */}
      {unregistered > 0 && (
        <Card className="mb-4 border-2 border-red-200">
          <h2 className="mb-1 font-bold text-red-700">
            Not registered with LATRA ({unregistered})
          </h2>
          <p className="mb-3 text-xs text-gray-600">
            LATRA only accepts a trip whose driver and vehicle it already holds. Until these are
            registered, <strong>their trips cannot be reported</strong>. Fix the underlying detail
            (licence must be 10 digits; licence class and email are required), then retry.
          </p>

          {issues.drivers.length > 0 && (
            <table className="mb-3 w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-1 pr-3">Driver</th>
                  <th className="pr-3">Licence</th>
                  <th className="pr-3">Class</th>
                  <th className="pr-3">Email</th>
                  <th className="pr-3">Reason</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {issues.drivers.map((d) => (
                  <tr key={d.id} className="border-b">
                    <td className="py-1 pr-3">
                      {d.name} <span className="text-xs text-gray-500">{d.phone}</span>
                    </td>
                    <td className="pr-3 font-mono text-xs">{d.licenseNumber ?? "—"}</td>
                    <td className="pr-3">{d.licenceCategory ?? "—"}</td>
                    <td className="pr-3 text-xs">{d.email ?? "—"}</td>
                    <td className="pr-3 text-xs text-red-600">{d.error ?? "not attempted"}</td>
                    <td>
                      <button
                        className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => void api("POST", `/admin/latra-register-driver/${d.id}`, {}).then(refresh)}
                      >
                        Retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {issues.vehicles.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-1 pr-3">Vehicle</th>
                  <th className="pr-3">Class</th>
                  <th className="pr-3">Reason</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {issues.vehicles.map((v) => (
                  <tr key={v.id} className="border-b">
                    <td className="py-1 pr-3 font-mono">{v.plateNumber}</td>
                    <td className="pr-3">{v.class}</td>
                    <td className="pr-3 text-xs text-red-600">{v.error ?? "not attempted"}</td>
                    <td>
                      <button
                        className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => void api("POST", `/admin/latra-register-vehicle/${v.id}`, {}).then(refresh)}
                      >
                        Retry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* LATRA requires one operational summary per day. Without a record we
          could not show which days were actually filed. */}
      <Card className="mb-4">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Daily reports</h2>
          <button
            className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
            onClick={() => void api("POST", "/admin/latra-daily-report", {}).then(refresh).catch(refresh)}
          >
            Submit yesterday
          </button>
        </div>
        {daily.length === 0 ? (
          <p className="text-sm text-gray-500">No daily report has been filed yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3">Date</th>
                <th className="pr-3">Trips</th>
                <th className="pr-3">Total (TZS)</th>
                <th className="pr-3">Status</th>
                <th className="pr-3">Attempts</th>
                <th className="pr-3">Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.id} className="border-b">
                  <td className="py-1 pr-3 font-mono text-xs">{d.reportDate}</td>
                  <td className="pr-3">{d.totalTrip}</td>
                  <td className="pr-3">{d.totalPaidAmount.toLocaleString()}</td>
                  <td className="pr-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[d.status] ?? ""}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="pr-3">{d.attempts}</td>
                  <td className="pr-3 text-xs text-red-600">{d.lastError}</td>
                  <td>
                    {d.status !== "ACKED" && (
                      <button
                        className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() =>
                          void api("POST", "/admin/latra-daily-report", { date: d.reportDate })
                            .then(refresh)
                            .catch(refresh)
                        }
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">LATRA trip reports (outbox)</h2>
          <select
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {["PENDING", "SENT", "ACKED", "FAILED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-3">Created</th>
              <th className="pr-3">Trip</th>
              <th className="pr-3">Status</th>
              <th className="pr-3">Attempts</th>
              <th className="pr-3">Last error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-1 pr-3 text-xs text-gray-500">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="pr-3 font-mono text-xs">{r.tripId.slice(0, 12)}…</td>
                <td className="pr-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[r.status] ?? ""}`}>{r.status}</span>
                </td>
                <td className="pr-3">{r.attempts}</td>
                <td className="pr-3 text-xs text-red-600">{r.lastError}</td>
                <td>
                  {r.status === "FAILED" && (
                    <button
                      className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                      onClick={() => void api("POST", `/admin/latra-reports/${r.id}/retry`, {}).then(refresh)}
                    >
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </StaffShell>
  );
}
