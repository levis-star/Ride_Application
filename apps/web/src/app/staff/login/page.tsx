"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";
import { Button, Card, Input } from "@/components/ui";

export default function StaffLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("+255");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ accessToken: string; role: string; name: string }>("POST", "/auth/staff/login", {
        phone,
        password,
      });
      setToken(res.accessToken);
      window.localStorage.setItem("rr_role", res.role);
      window.localStorage.setItem("rr_name", res.name);
      router.replace(res.role === "ADMIN" ? "/staff/admin" : "/staff/dispatch");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-100 p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-black text-brand-700">RukwaRide Staff</h1>
        <p className="mb-4 text-sm text-gray-500">Dispatcher & Admin console</p>
        <form className="space-y-3" onSubmit={submit}>
          <Input
            type="tel"
            placeholder="+2557XXXXXXXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^+\d]/g, ""))}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={busy || password.length < 8}>
            Sign in
          </Button>
        </form>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </Card>
    </main>
  );
}
