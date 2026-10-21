import { t } from "@/lib/i18n";

/**
 * LATRA Stage-1 #10 receipt: starting point, ending point, fares AND time.
 * Shared by the trip-completion screen and the history list so both show the
 * same four required elements.
 */
export interface ReceiptData {
  from: string;
  to: string;
  startedAt: string | null;
  completedAt: string | null;
  durationS: number | null;
  distanceM: number | null;
  fareBreakdown: { base?: number; distanceCharge?: number; timeCharge?: number; bookingFee?: number } | null;
  total: number;
}

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("sw-TZ", { hour: "2-digit", minute: "2-digit" }) : "—";

export default function Receipt({ from, to, startedAt, completedAt, durationS, distanceM, fareBreakdown, total }: ReceiptData) {
  return (
    <div className="text-sm text-gray-600">
      <p className="mb-2 font-semibold">{t("receipt")}</p>

      <div className="mb-2 space-y-0.5">
        <div className="flex justify-between gap-3">
          <span className="shrink-0">{t("rcpt_from")}</span>
          <span className="text-right font-medium text-gray-800">{from}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="shrink-0">{t("rcpt_to")}</span>
          <span className="text-right font-medium text-gray-800">{to}</span>
        </div>
      </div>

      <div className="mb-2 space-y-0.5 border-t border-gray-100 pt-2">
        <div className="flex justify-between">
          <span>{t("rcpt_started")}</span>
          <span>{clock(startedAt)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("rcpt_ended")}</span>
          <span>{clock(completedAt)}</span>
        </div>
        {durationS !== null && (
          <div className="flex justify-between">
            <span>{t("rcpt_duration")}</span>
            <span>{Math.max(1, Math.round(durationS / 60))} dk</span>
          </div>
        )}
        {distanceM !== null && (
          <div className="flex justify-between">
            <span>{t("distance")}</span>
            <span>{(distanceM / 1000).toFixed(1)} km</span>
          </div>
        )}
      </div>

      {fareBreakdown && (
        <div className="space-y-0.5 border-t border-gray-100 pt-2">
          <div className="flex justify-between"><span>Base</span><span>{fareBreakdown.base}</span></div>
          <div className="flex justify-between"><span>{t("distance")}</span><span>{fareBreakdown.distanceCharge}</span></div>
          <div className="flex justify-between"><span>Muda</span><span>{fareBreakdown.timeCharge}</span></div>
          <div className="flex justify-between"><span>{t("booking_fee")}</span><span>{fareBreakdown.bookingFee}</span></div>
          <div className="flex justify-between border-t border-gray-100 pt-1 font-bold text-gray-900">
            <span>{t("rcpt_total")}</span>
            <span>TZS {total.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
