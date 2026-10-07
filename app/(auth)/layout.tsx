import type { ReactNode } from "react";
import { businessProfile } from "@/lib/settings";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const business = await businessProfile();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        {business.logoFileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the logo is served by the suite itself
          <img src="/logo" alt="" className="size-10 rounded-lg object-contain" />
        ) : null}
        <p className="text-lg font-semibold">{business.name}</p>
      </div>
      {children}
    </main>
  );
}
