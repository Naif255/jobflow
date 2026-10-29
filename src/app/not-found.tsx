import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3 py-16 text-center">
      <h1 className="text-2xl font-semibold">الصفحة غير موجودة</h1>
      <Link href="/jobs" className="text-sm text-zinc-400 underline hover:text-white">
        العودة إلى الوظائف
      </Link>
    </div>
  );
}
