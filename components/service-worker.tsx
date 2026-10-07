"use client";

import { useEffect } from "react";

/** Registers /sw.js (Web Push and the "install as an app" prompt). Needs HTTPS, or localhost. */
export function ServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
  }, []);
  return null;
}
