import type { NextConfig } from "next";

const root = import.meta.dirname;

const nextConfig: NextConfig = {
  // A self-contained server (`.next/standalone/server.js`) for the Docker image.
  output: "standalone",
  // The smoke test runs its own dev server beside yours (playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The suite is its own project: never let Next pick a parent folder as the root.
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // Native password hashing: loaded from node_modules at runtime, never bundled.
  serverExternalPackages: ["@node-rs/argon2"],
  experimental: {
    // File uploads (logo, attachments) go through server actions and routes.
    serverActions: { bodySizeLimit: "12mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
