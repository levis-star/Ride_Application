"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Input } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface AuditRow {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [entity, setEntity] = useState("");
  const [skip, setSkip] = useState(0);

  const refresh = useCallback(() => {
    void api<AuditRow[]>("GET", `/admin/audit?take=50&skip=${skip}${entity ? `&entity=${entity}` : ""}`)
      .then(setRows)
      .catch(() => {});
  }, [entity, skip]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Audit log</h2>
          <div className="w-56">
            <Input placeholder="Filter by entity (e.g. Trip)…" value={entity} onChange={(e) => { setSkip(0); setEntity(e.target.value); }} />
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-3">When</th>
              <th className="pr-3">Actor</th>
              <th className="pr-3">Action</th>
              <th className="pr-3">Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b align-top">
                <td className="py-1 pr-3 text-xs text-gray-500">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="pr-3 font-mono text-xs">{r.actorId.slice(0, 10)}</td>
                <td className="pr-3 font-medium">{r.action}</td>
                <td className="pr-3 font-mono text-xs">
                  {r.entity}/{r.entityId.slice(0, 10)}
                </td>
                <td className="max-w-md truncate text-xs text-gray-500">
                  {r.before ? `before: ${JSON.stringify(r.before)} ` : ""}
                  {r.after ? `after: ${JSON.stringify(r.after)}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" className="!w-auto !py-1.5 text-sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - 50))}>
            ← Prev
          </Button>
          <Button variant="outline" className="!w-auto !py-1.5 text-sm" disabled={rows.length < 50} onClick={() => setSkip(skip + 50)}>
            Next →
          </Button>
        </div>
      </Card>
    </StaffShell>
  );
}
