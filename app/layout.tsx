import type { Metadata } from "next";
import Link from "next/link";
import { formatDateTime } from "./components.tsx";
import { loadDashboard } from "./lib/data.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Integration Health",
  description: "Daily status of third-party API integrations: what's broken, what will break and when.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { generatedAt } = loadDashboard();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Integration Health
            </Link>
            <nav className="flex gap-4 text-sm text-slate-600 dark:text-slate-400">
              <Link href="/" className="hover:text-slate-900 dark:hover:text-slate-100">
                Overview
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-slate-500 dark:text-slate-400">
          Data from the monitor run at {formatDateTime(generatedAt)}. Rules-only classification, no API keys. Every flag links to its source.
        </footer>
      </body>
    </html>
  );
}
