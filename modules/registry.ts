/**
 * The installed modules, in the order the launcher shows them. Keep this list
 * and modules/installed.json in step (`pnpm suite:new-module <id>` edits both;
 * a unit test checks they agree).
 */
import type { ModuleManifest } from "@/lib/modules/contract";
import { announcements } from "./announcements/manifest";
import { tasks } from "./tasks/manifest";
import { docs } from "./docs/manifest";
import { customers } from "./customers/manifest";
import { assistant } from "./assistant/manifest";
import { chat } from "./chat/manifest";
import { funnel } from "./funnel/manifest";

export const modules: ModuleManifest[] = [
  announcements,
  tasks,
  docs,
  customers,
  assistant,
  chat,
  funnel,
];
