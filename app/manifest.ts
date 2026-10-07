import type { MetadataRoute } from "next";
import { businessProfile, isSetupDone } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let name = "Business suite";
  try {
    if (await isSetupDone()) name = (await businessProfile()).name;
  } catch {
    // Database not ready: fall back to the generic name.
  }
  return {
    name,
    short_name: name.slice(0, 12),
    description: `${name}'s own apps.`,
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f3",
    theme_color: "#1f5f8b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
