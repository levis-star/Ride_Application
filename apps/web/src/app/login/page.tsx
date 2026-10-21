"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button, Card, Input } from "@/components/ui";

type Step = "phone" | "code" | "name";

export default function LoginPage() {
  const router = useRouter();
  // Post-login destination (e.g. /driver onboarding sends people here).
  const dest = () =>
    typeof window === "undefined" ? "/" : (new URLSearchParams(window.location.search).get("next") ?? "/");
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("+255");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoCode, setDemoCode] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <div className="text-4xl font-black text-brand-600">RukwaRide</div>
        <p className="mt-1 text-sm text-gray-500">Sumbawanga • bodaboda • bajaji • gari</p>
      </div>

      <Card>
        {step === "phone" && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                // Demo mode returns the code (no SMS) — prefill it for the tester.
                const res = await api<{ ok: boolean; demoCode?: string }>("POST", "/auth/otp/request", { phone });
                if (res.demoCode) {
                  setDemoCode(res.demoCode);
                  setCode(res.demoCode);
                }
                setStep("code");
              });
            }}
          >
            <h1 className="text-lg font-bold">{t("login_title")}</h1>
            <Input
              type="tel"
              inputMode="tel"
              placeholder={t("phone_placeholder")}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^+\d]/g, ""))}
              autoFocus
            />
            <Button type="submit" disabled={busy || phone.length < 10}>
              {t("send_code")}
            </Button>
          </form>
        )}

        {step === "code" && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const res = await api<{ accessToken: string; name: string }>("POST", "/auth/otp/verify", {
                  phone,
                  code,
                });
                setToken(res.accessToken);
                if (!res.name) setStep("name");
                else router.replace(dest());
              });
            }}
          >
            <h1 className="text-lg font-bold">{t("enter_code")}</h1>
            <p className="text-sm text-gray-500">{phone}</p>
            {demoCode && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Demo: nambari yako ni <span className="font-mono font-bold">{demoCode}</span> (imejazwa)
              </div>
            )}
            <Input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              className="text-center text-2xl tracking-[0.5em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {t("verify")}
            </Button>
          </form>
        )}

        {step === "name" && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("PATCH", "/users/me", { name });
                router.replace(dest());
              });
            }}
          >
            <h1 className="text-lg font-bold">{t("your_name")}</h1>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <Button type="submit" disabled={busy || name.trim().length < 2}>
              {t("save")}
            </Button>
          </form>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </Card>
    </main>
  );
}
