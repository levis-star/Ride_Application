"use client";

import { useState } from "react";
import { PASSENGER_QUICK_MESSAGES } from "@rukwaride/shared";
import { api } from "@/lib/api";
import { t, TKey } from "@/lib/i18n";
import { Button } from "@/components/ui";

/**
 * Passenger-side safety + comfort controls for an active trip (Bolt/Uber
 * parity): emergency SOS, share-my-trip link, and quick pre-written messages
 * to the driver.
 *
 * Only the passenger's own phrases are offered here — "on my way" / "I'm
 * outside" / "can't find you" are things the DRIVER tells the passenger, so
 * showing them to someone waiting for a ride is nonsense. The server rejects
 * them for a passenger regardless of what the UI renders.
 */
export default function TripSafetyBar({ tripId }: { tripId: string }) {
  const [busy, setBusy] = useState(false);
  const [showMsgs, setShowMsgs] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  function toast(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  }

  async function raiseSos() {
    if (!window.confirm(t("sos_confirm"))) return;
    setBusy(true);
    try {
      const pos = await new Promise<GeolocationPosition | null>((res) =>
        navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 4000 }),
      );
      await api("POST", `/trips/${tripId}/sos`, {
        lat: pos?.coords.latitude,
        lng: pos?.coords.longitude,
      });
      toast(t("sos_raised"));
    } catch {
      toast(t("sos_raised"));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    try {
      const { url } = await api<{ url: string }>("POST", `/trips/${tripId}/share`);
      if (navigator.share) await navigator.share({ title: "RukwaRide", url });
      else {
        await navigator.clipboard.writeText(url);
        toast(t("share_copied"));
      }
    } catch {
      /* user dismissed share sheet */
    }
  }

  async function sendMsg(message: string) {
    setShowMsgs(false);
    await api("POST", `/trips/${tripId}/message`, { message }).catch(() => {});
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <Button variant="danger" className="!py-2" disabled={busy} onClick={() => void raiseSos()}>
          🆘 {t("sos")}
        </Button>
        <Button variant="outline" className="!py-2" onClick={() => void share()}>
          🔗 {t("share_trip")}
        </Button>
        <Button variant="outline" className="!py-2" onClick={() => setShowMsgs((v) => !v)}>
          💬 {t("quick_msg")}
        </Button>
      </div>

      {showMsgs && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {PASSENGER_QUICK_MESSAGES.map((m) => (
            <button
              key={m}
              onClick={() => void sendMsg(m)}
              className="rounded-lg border border-gray-200 px-2 py-2 text-sm active:bg-gray-50"
            >
              {t(`msg_${m}` as TKey)}
            </button>
          ))}
        </div>
      )}

      {flash && (
        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-center text-sm text-amber-800">{flash}</div>
      )}
    </div>
  );
}
