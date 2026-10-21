"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import StaffShell from "../../StaffShell";

interface Entry {
  id: string;
  txnId: string;
  account: string;
  driverId: string | null;
  debit: number;
  credit: number;
  tripId: string | null;
  memo: string | null;
  at: string;
}

const ACCOUNTS = ["", "DRIVER_WALLET", "PLATFORM_REVENUE", "PLATFORM_RECEIVABLE", "PASSENGER_ESCROW", "AGGREGATOR_CLEARING"];

export default function LedgerPage() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [account, setAccount] = useState("");
  const [skip, setSkip] = useState(0);
  const [reconcile, setReconcile] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api<Entry[]>("GET", `/admin/ledger?take=50&skip=${skip}${account ? `&account=${account}` : ""}`)
      .then(setRows)
      .catch(() => {});
  }, [account, skip]);

  useEffect(refresh, [refresh]);

  return (
    <StaffShell>
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-bold">Ledger</h2>
          <select
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            value={account}
            onChange={(e) => {
              setSkip(0);
              setAccount(e.target.value);
            }}
          >
            {ACCOUNTS.map((a) => (
              <option key={a} value={a}>
                {a || "All accounts"}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              className="!w-auto !py-1.5 text-sm"
              onClick={() =>
                void api<{ globalSum: number; driversChecked: number; driftFixed: number }>(
                  "POST",
                  "/payments/admin/reconcile",
                ).then((r) =>
                  setReconcile(`global sum ${r.globalSum} · ${r.driversChecked} wallets checked · ${r.driftFixed} drift fixed`),
                )
              }
            >
              Run reconciliation
            </Button>
            {reconcile && <span className="text-sm text-gray-600">{reconcile}</span>}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-3">When</th>
              <th className="pr-3">Account</th>
              <th className="pr-3 text-right">Debit</th>
              <th className="pr-3 text-right">Credit</th>
              <th className="pr-3">Memo</th>
              <th>Txn</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="py-1 pr-3 text-xs text-gray-500">{new Date(e.at).toLocaleString()}</td>
                <td className="pr-3 font-mono text-xs">{e.account}</td>
                <td className="pr-3 text-right text-red-700">{e.debit || ""}</td>
                <td className="pr-3 text-right text-brand-700">{e.credit || ""}</td>
                <td className="pr-3">{e.memo}</td>
                <td className="font-mono text-xs text-gray-400">{e.txnId.slice(0, 8)}</td>
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
