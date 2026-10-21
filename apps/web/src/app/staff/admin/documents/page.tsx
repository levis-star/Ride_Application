"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";
import { Card } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface DocRow {
  id: string;
  type: string;
  status: string;
  fileUrl: string;
  rejectionReason: string | null;
  driver: { id: string; name: string; phone: string };
  createdAt: string;
}

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [status, setStatus] = useState("PENDING_REVIEW");

  const refresh = useCallback(() => {
    void api<DocRow[]>("GET", `/admin/documents?status=${status}`).then(setRows).catch(() => {});
  }, [status]);

  useEffect(refresh, [refresh]);

  // Uploaded files live behind the API's auth, so an <a href> can't carry the
  // bearer token — fetch as a blob and open the object URL instead.
  async function openFile(id: string) {
    const res = await fetch(`${API_URL}/admin/documents/${id}/file`, {
      headers: { authorization: `Bearer ${getToken() ?? ""}` },
    });
    if (!res.ok) return;
    window.open(URL.createObjectURL(await res.blob()), "_blank");
  }

  async function review(id: string, decision: "APPROVED" | "REJECTED") {
    const rejectionReason = decision === "REJECTED" ? window.prompt("Rejection reason (required):") : undefined;
    if (decision === "REJECTED" && !rejectionReason) return;
    await api("POST", `/admin/documents/${id}/review`, { decision, rejectionReason });
    refresh();
  }

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Document review queue</h2>
          <select
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {["PENDING_REVIEW", "APPROVED", "REJECTED", "EXPIRED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-3">Driver</th>
              <th className="pr-3">Type</th>
              <th className="pr-3">File</th>
              <th className="pr-3">Submitted</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b">
                <td className="py-2 pr-3">
                  {d.driver.name} <span className="text-xs text-gray-400">{d.driver.phone}</span>
                </td>
                <td className="pr-3">{d.type}</td>
                <td className="pr-3">
                  <button className="text-blue-600 underline" onClick={() => void openFile(d.id)}>
                    view
                  </button>
                </td>
                <td className="pr-3 text-xs text-gray-500">{new Date(d.createdAt).toLocaleString()}</td>
                <td className="space-x-1">
                  {d.status === "PENDING_REVIEW" ? (
                    <>
                      <button
                        className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => void review(d.id, "APPROVED")}
                      >
                        Approve
                      </button>
                      <button
                        className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white"
                        onClick={() => void review(d.id, "REJECTED")}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500">
                      {d.status}
                      {d.rejectionReason ? ` — ${d.rejectionReason}` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-400">
                  Queue empty
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </StaffShell>
  );
}
