"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { getToken, setToken } from "@/lib/api";

const ADMIN_NAV = [
  ["/staff/admin", "Dashboard"],
  ["/staff/dispatch", "Dispatch"],
  ["/staff/admin/drivers", "Drivers"],
  ["/staff/admin/documents", "Documents"],
  ["/staff/admin/fares", "Fares"],
  ["/staff/admin/landmarks", "Landmarks"],
  ["/staff/admin/ledger", "Ledger"],
  ["/staff/admin/latra", "LATRA"],
  ["/staff/admin/tickets", "Tickets"],
  ["/staff/admin/audit", "Audit"],
] as const;

const DISPATCHER_NAV = [["/staff/dispatch", "Dispatch"]] as const;

/** Client-side shell for staff pages (RBAC is enforced by the API). */
export default function StaffShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/staff/login");
      return;
    }
    setRole(window.localStorage.getItem("rr_role"));
  }, [router]);

  if (!role) return null;
  const nav = role === "ADMIN" ? ADMIN_NAV : DISPATCHER_NAV;

  return (
    <div className="min-h-dvh bg-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2">
          <span className="font-black text-brand-700">RukwaRide {role === "ADMIN" ? "Admin" : "Dispatch"}</span>
          <nav className="flex gap-1 overflow-x-auto">
            {nav.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  pathname === href ? "bg-brand-100 text-brand-700" : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <button
            className="ml-auto text-sm text-gray-500 underline"
            onClick={() => {
              setToken(null);
              window.localStorage.removeItem("rr_role");
              router.replace("/staff/login");
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}
