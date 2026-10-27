import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Medrella — Appointment Booking",
  description:
    "Book appointments with verified doctors, manage your schedule, and track consultations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans`}>
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
        <footer className="mt-16 border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} Medrella · Patient Management System</p>
            <p>Built with Next.js, Drizzle ORM & Neon Postgres</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
