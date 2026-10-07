"use client";

import { useEffect, useState } from "react";

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "loading" | "unsupported" | "insecure" | "denied" | "off" | "on" | "working";

/** Turns Web Push on or off for this browser. Needs HTTPS (or localhost). */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      if (!window.isSecureContext) return setState("insecure");
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function turnOn() {
    setError("");
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "denied" : "off");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
      const res = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The server did not save the subscription.");
      setState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push could not be turned on.");
      setState("off");
    }
  }

  async function turnOff() {
    setError("");
    setState("working");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push could not be turned off.");
      setState("on");
    }
  }

  const messages: Partial<Record<State, string>> = {
    loading: "Checking this browser…",
    unsupported: "This browser cannot receive push notifications. On an iPhone, add the suite to the Home Screen first (Share → Add to Home Screen), then open it from there.",
    insecure: "Push notifications need the suite to be opened over HTTPS.",
    denied: "Notifications are blocked for this site in the browser's settings. Allow them there, then reload.",
  };
  return (
    <div className="space-y-2">
      {messages[state] ? <p className="muted text-sm">{messages[state]}</p> : null}
      {state === "off" || state === "on" || state === "working" ? (
        <button type="button" className={state === "on" ? "btn" : "btn btn-primary"} disabled={state === "working"} onClick={state === "on" ? turnOff : turnOn}>
          {state === "on" ? "Turn off on this device" : state === "working" ? "Working…" : "Turn on for this device"}
        </button>
      ) : null}
      {state === "on" ? <p className="text-sm text-ok">Push notifications are on for this device.</p> : null}
      {error ? <p className="notice notice-error">{error}</p> : null}
    </div>
  );
}
