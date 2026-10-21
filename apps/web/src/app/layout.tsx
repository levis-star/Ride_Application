import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import SentryInit from "@/components/SentryInit";
import "./globals.css";

export const metadata: Metadata = {
  title: "RukwaRide",
  description: "Usafiri wa haraka Sumbawanga — bodaboda, bajaji na gari.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "RukwaRide", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#15803d",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The nonce the CSP middleware minted for this request; our one inline script
  // must carry it or a strict script-src blocks it (security assessment L-3).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="sw">
      <body>
        <SentryInit />
        <div className="mx-auto min-h-dvh max-w-md">{children}</div>
        <script
          nonce={nonce}
          // Offline shell (spec §13: installable PWA).
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))}`,
          }}
        />
      </body>
    </html>
  );
}
