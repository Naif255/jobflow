import type { Metadata } from "next";
import Link from "next/link";
import { Geist_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";

const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-arabic",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jobflow",
  description: "تقييم الوظائف مقابل ملفك الشخصي وتخصيص سيرتك الذاتية",
};

const nav = [
  { href: "/", label: "إضافة وظيفة" },
  { href: "/jobs", label: "الوظائف" },
  { href: "/profile", label: "الملف الشخصي" },
  { href: "/answers", label: "الإجابات" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className={`${plexArabic.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
          <nav className="mx-auto flex max-w-4xl items-center gap-6 overflow-x-auto px-4 py-3">
            <Link href="/" className="shrink-0 font-semibold tracking-tight" dir="ltr">
              jobflow
            </Link>
            <div className="flex shrink-0 gap-5 text-sm text-zinc-400">
              {nav.map((item) => (
                <Link key={item.href} href={item.href} className="transition-colors hover:text-white">
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
