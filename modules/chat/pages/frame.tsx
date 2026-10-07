import Link from "next/link";
import type { ReactNode } from "react";
import type { ModuleContext } from "@/lib/modules/contract";
import { SidebarList } from "../components/sidebar-list";
import { ensureDefaultMemberships } from "../channels";
import { P, sidebar } from "../data";

/**
 * Two panes on a wide screen (conversations on the left), one on a phone:
 * the list on the chat home page, the conversation everywhere else, with a
 * link back to the list.
 */
export async function ChatFrame({ ctx, basePath, currentId, listOnPhone = false, children }: { ctx: ModuleContext; basePath: string; currentId?: string | null; listOnPhone?: boolean; children: ReactNode }) {
  // Whatever chat page someone opens first, they land in the default channels once.
  await ensureDefaultMemberships(ctx);
  const data = await sidebar(ctx.db, ctx.viewer);
  const guest = ctx.viewer.role === "guest";
  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className={`${listOnPhone ? "" : "hidden"} lg:block`}>
        <div className="lg:sticky lg:top-6">
          <SidebarList
            initial={data}
            currentId={currentId ?? null}
            base={basePath}
            canCreate={!guest && ctx.can(P.create)}
            canBrowse={!guest}
            canImport={ctx.can(P.import)}
            canManage={ctx.can(P.manage)}
          />
        </div>
      </aside>
      <div className={`${listOnPhone ? "hidden lg:block" : ""} min-w-0`}>
        {!listOnPhone ? (
          <Link href={basePath} className="link mb-2 inline-block text-sm lg:hidden">
            ← All conversations
          </Link>
        ) : null}
        {children}
      </div>
    </div>
  );
}
