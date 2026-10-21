"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken, setToken } from "@/lib/api";
import { t, TKey } from "@/lib/i18n";
import { Button, Card, Input, Spinner } from "@/components/ui";

/**
 * Driver self-onboarding (spec §12/§13): register → upload documents →
 * wait for office approval. The Expo driver app shows the same checklist;
 * this page exists so onboarding works on any phone browser.
 */

const CLASSES = [
  { value: "BODABODA", icon: "🏍️", label: "Bodaboda" },
  { value: "BAJAJI", icon: "🛺", label: "Bajaji" },
  { value: "CAR", icon: "🚗", label: "Gari" },
] as const;

/** Tanzanian driving licence classes (A motorcycle, B/C light, D/E heavy). */
const LICENCE_CATEGORIES = ["A", "B", "C", "D", "E"] as const;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface DocRow {
  id: string;
  type: string;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "EXPIRED";
  rejectionReason: string | null;
}

interface Onboarding {
  approvedAt: string | null;
  requiredDocuments: string[];
  documents: DocRow[];
  missingDocuments: string[];
  documentsApproved: boolean;
  vehicle: { plateNumber: string; class: string } | null;
  canGoOnline: boolean;
}

function docLabel(type: string): string {
  const key = `drv_doc_${type}` as TKey;
  const label = t(key);
  return label === key ? type : label;
}

export default function DriverOnboardingPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "register" | "checklist">("loading");
  const [ob, setOb] = useState<Onboarding | null>(null);
  const [name, setName] = useState("");
  const [vehicleClass, setVehicleClass] = useState<string>("BODABODA");
  const [plate, setPlate] = useState("");
  const [license, setLicense] = useState("");
  const [licenceCategory, setLicenceCategory] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTypeRef = useRef<string>("");

  const refresh = useCallback(async () => {
    try {
      const data = await api<Onboarding>("GET", "/drivers/me/onboarding");
      setOb(data);
      setPhase("checklist");
    } catch (e) {
      // PASSENGER-role token → 403: not registered yet, show the form.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setPhase("register");
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login?next=/driver");
      return;
    }
    void refresh();
  }, [refresh, router]);

  // Live-update the checklist while waiting on admin review/approval.
  useEffect(() => {
    if (phase !== "checklist" || ob?.canGoOnline) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [phase, ob?.canGoOnline, refresh]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ accessToken: string }>("POST", "/drivers/register", {
        name,
        vehicleClass,
        plateNumber: plate,
        licenseNumber: license.trim(),
        licenceCategory,
        email: email.trim(),
      });
      setToken(res.accessToken); // fresh DRIVER-role token
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pickFile(type: string) {
    uploadTypeRef.current = type;
    fileInputRef.current?.click();
  }

  async function onFile(file: File | undefined) {
    if (!file || !uploadTypeRef.current) return;
    if (!ALLOWED_TYPES.includes(file.type)) return setError(`${file.type || "?"} — jpg/png/webp/pdf`);
    if (file.size > MAX_FILE_BYTES) return setError(t("drv_file_too_big"));
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(file);
      });
      await api("POST", "/drivers/me/documents", {
        type: uploadTypeRef.current,
        contentType: file.type,
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const latestFor = (type: string) => ob?.documents.find((d) => d.type === type);

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-4 p-4">
      <div className="flex items-center gap-2">
        <button onClick={() => router.push("/")} className="text-2xl" aria-label={t("home")}>
          ←
        </button>
        <h1 className="text-xl font-black text-brand-700">{t("drv_title")}</h1>
      </div>

      {phase === "loading" && (
        <div className="flex justify-center pt-20">
          <Spinner />
        </div>
      )}

      {phase === "register" && (
        <Card>
          <p className="text-sm text-gray-600">{t("drv_intro")}</p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void register();
            }}
          >
            <Input placeholder={t("your_name")} value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <p className="mb-2 text-sm font-medium">{t("drv_vehicle_class")}</p>
              <div className="grid grid-cols-3 gap-2">
                {CLASSES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setVehicleClass(c.value)}
                    className={`rounded-xl border-2 p-3 text-center ${
                      vehicleClass === c.value ? "border-brand-600 bg-brand-50" : "border-gray-200"
                    }`}
                  >
                    <div className="text-2xl">{c.icon}</div>
                    <div className="text-xs font-medium">{c.label}</div>
                  </button>
                ))}
              </div>
            </div>
            <Input
              placeholder={t("drv_plate")}
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
            />
            {/* Licence number, category and email are all required by LATRA's
                e-ticketing system. A driver missing any of them cannot be
                registered with LATRA, so we collect them up front rather than
                discovering it when their first trip fails to report. */}
            <div>
              <Input
                placeholder={t("drv_license")}
                inputMode="numeric"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
              />
              <p className="mt-1 text-xs text-gray-500">{t("drv_license_hint")}</p>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">{t("drv_licence_category")}</p>
              <div className="grid grid-cols-4 gap-2">
                {LICENCE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setLicenceCategory(c)}
                    className={`rounded-xl border-2 py-2 text-center text-sm font-medium ${
                      licenceCategory === c ? "border-brand-600 bg-brand-50" : "border-gray-200"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <Input
              placeholder={t("drv_email")}
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="submit"
              disabled={
                busy ||
                name.trim().length < 2 ||
                plate.trim().length < 4 ||
                license.replace(/\D/g, "").length !== 10 ||
                !licenceCategory ||
                !email.includes("@")
              }
            >
              {t("drv_register")}
            </Button>
          </form>
        </Card>
      )}

      {phase === "checklist" && ob && (
        <>
          {/* Step 1 — registered */}
          <Card className="flex items-center gap-3">
            <span className="text-xl">✅</span>
            <div>
              <p className="font-bold">{t("drv_step_registered")}</p>
              {ob.vehicle && (
                <p className="text-sm text-gray-500">
                  {CLASSES.find((c) => c.value === ob.vehicle!.class)?.icon}{" "}
                  <span className="font-mono">{ob.vehicle.plateNumber}</span>
                </p>
              )}
            </div>
          </Card>

          {/* Step 2 — documents */}
          <Card>
            <p className="mb-3 font-bold">
              {ob.documentsApproved ? "✅" : "📄"} {t("drv_step_docs")}
            </p>
            <div className="space-y-3">
              {ob.requiredDocuments.map((type) => {
                const doc = latestFor(type);
                return (
                  <div key={type} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{docLabel(type)}</p>
                      {doc?.status === "PENDING_REVIEW" && (
                        <p className="text-xs text-amber-600">{t("drv_pending_review")}</p>
                      )}
                      {doc?.status === "APPROVED" && (
                        <p className="text-xs text-green-600">{t("drv_doc_approved")} ✓</p>
                      )}
                      {doc?.status === "REJECTED" && (
                        <p className="text-xs text-red-600">
                          {t("drv_doc_rejected")}
                          {doc.rejectionReason ? ` — ${doc.rejectionReason}` : ""}
                        </p>
                      )}
                    </div>
                    {(!doc || doc.status === "REJECTED" || doc.status === "EXPIRED") && (
                      <Button
                        variant="outline"
                        className="!w-auto shrink-0 !px-3 !py-2 text-sm"
                        disabled={busy}
                        onClick={() => pickFile(type)}
                      >
                        {doc ? t("drv_reupload") : t("drv_upload")}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Step 3 — approval */}
          <Card className="flex items-center gap-3">
            <span className="text-xl">{ob.approvedAt ? "✅" : "⏳"}</span>
            <div>
              <p className="font-bold">{t("drv_step_approval")}</p>
              <p className="text-sm text-gray-500">
                {ob.approvedAt ? t("drv_approved_msg") : t("drv_awaiting_approval")}
              </p>
            </div>
          </Card>
        </>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
    </main>
  );
}
