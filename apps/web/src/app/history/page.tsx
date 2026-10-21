"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button, Card } from "@/components/ui";
import Receipt from "@/components/Receipt";

interface HistoryRow {
  id: string;
  status: string;
  vehicleClass: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  finalDistanceM: number | null;
  finalDurationS: number | null;
  pickupLabel: string;
  dropLabel: string;
  estimatedFare: number;
  finalFare: number | null;
  fareBreakdown: { base?: number; distanceCharge?: number; timeCharge?: number; bookingFee?: number } | null;
}

const STATUS_BADGE: Record<string, string> = {
  COMPLETED: "bg-brand-100 text-brand-700",
  EXPIRED: "bg-gray-100 text-gray-500",
  CANCELLED_BY_PASSENGER: "bg-red-50 text-red-600",
  CANCELLED_BY_DRIVER: "bg-red-50 text-red-600",
};

export default function HistoryPage() {
  const router = useRouter();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    void api<HistoryRow[]>("GET", "/trips").then(setRows).catch(() => setRows([]));
  }, [router]);

  return (
    <main className="min-h-dvh p-4 pb-24">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">{t("history")}</h1>
        <button
          className="text-sm text-gray-500 underline"
          onClick={() => {
            setToken(null);
            router.replace("/login");
          }}
        >
          {t("logout")}
        </button>
      </div>

      <div className="space-y-3">
        {rows?.map((r) => (
          <Card key={r.id} className="!p-0">
            <button className="w-full p-4 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">{new Date(r.createdAt).toLocaleString("sw-TZ")}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status] ?? "bg-gray-100"}`}>
                  {r.status}
                </span>
              </div>
              <p className="mt-2 text-sm">
                <span className="font-medium">{r.pickupLabel}</span>
                <span className="text-gray-400"> → </span>
                <span className="font-medium">{r.dropLabel}</span>
              </p>
              <p className="mt-1 font-bold">
                TZS {(r.finalFare ?? r.estimatedFare).toLocaleString()}
                {r.finalFare === null && <span className="ml-1 text-xs font-normal text-gray-400">(kadirio)</span>}
              </p>
            </button>
            {/* LATRA Stage-1 #10: a receipt must carry the starting point,
                the ending point, the fares AND the time. Shared with the
                trip-completion screen via <Receipt />. */}
            {open === r.id && r.fareBreakdown && (
              <div className="border-t border-gray-100 p-4">
                <Receipt
                  from={r.pickupLabel}
                  to={r.dropLabel}
                  startedAt={r.startedAt}
                  completedAt={r.completedAt}
                  durationS={r.finalDurationS}
                  distanceM={r.finalDistanceM}
                  fareBreakdown={r.fareBreakdown}
                  total={r.finalFare ?? r.estimatedFare}
                />
              </div>
            )}
          </Card>
        ))}
        {rows?.length === 0 && <p className="py-10 text-center text-gray-400">—</p>}
      </div>

      <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md p-4">
        <Button onClick={() => router.push("/")}>{t("home")}</Button>
      </div>
    </main>
  );
}
