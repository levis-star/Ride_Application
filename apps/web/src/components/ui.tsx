"use client";

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-brand-600 text-white active:bg-brand-700 disabled:bg-gray-300",
    outline: "border border-gray-300 text-gray-800 bg-white active:bg-gray-50",
    ghost: "text-gray-700 active:bg-gray-100",
    danger: "bg-red-600 text-white active:bg-red-700",
  }[variant];
  return (
    <button
      className={`w-full rounded-xl px-4 py-3 text-base font-semibold transition disabled:opacity-60 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-gray-300 px-4 py-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${props.className ?? ""}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-4 shadow-lg ${className}`}>{children}</div>;
}

export function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center">
      <div className="pointer-events-auto w-full max-w-md rounded-t-3xl bg-white p-4 pb-6 shadow-[0_-8px_30px_rgba(0,0,0,0.15)]">
        {children}
      </div>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
  );
}

export function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex justify-center gap-2 text-4xl">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => onChange(n)} aria-label={`${n} stars`}>
          <span className={n <= value ? "text-yellow-400" : "text-gray-300"}>★</span>
        </button>
      ))}
    </div>
  );
}
