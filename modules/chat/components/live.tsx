"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One live connection per browser tab (EventSource on /api/m/chat/events),
 * shared by the sidebar and the conversation. EventSource reconnects by
 * itself and sends Last-Event-ID, so the server replays what changed; each
 * time the stream opens, listeners also get { k: "reconnected" } and fetch
 * their changes (covering the gap between drawing the page and connecting).
 */
export type LiveEvent =
  | { k: "m"; c: string; s: number; p?: string | null }
  | { k: "c"; c: string; u?: string[] }
  | { k: "r"; c: string; u: string[] }
  | { k: "reconnected" };

type Listener = (event: LiveEvent) => void;
type Status = "connecting" | "live" | "offline";

const listeners = new Set<Listener>();
const statusListeners = new Set<(s: Status) => void>();
let source: EventSource | null = null;
let status: Status = "connecting";
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(s: Status) {
  status = s;
  statusListeners.forEach((l) => l(s));
}

function emit(event: LiveEvent) {
  listeners.forEach((l) => l(event));
}

function connect() {
  if (source || typeof window === "undefined") return;
  const es = new EventSource("/api/m/chat/events");
  source = es;
  es.addEventListener("ready", () => {
    setStatus("live");
    // Also on the first connect: anything that changed between the page being drawn and the stream opening is fetched.
    emit({ k: "reconnected" });
  });
  es.addEventListener("unavailable", () => setStatus("offline"));
  es.onmessage = (e) => {
    try {
      emit(JSON.parse(e.data) as LiveEvent);
    } catch {
      // ignore a malformed line
    }
  };
  es.onerror = () => {
    setStatus(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
    if (es.readyState === EventSource.CLOSED) {
      // The server refused (signed out, or the app was switched off): try again later.
      source = null;
      setTimeout(() => {
        if (listeners.size) connect();
      }, 15_000);
    }
  };
}

function disconnectSoon() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
      setStatus("connecting");
    }
  }, 2000);
}

export function useLive(onEvent: Listener) {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    clearTimeout(closeTimer);
    connect();
    return () => {
      listeners.delete(l);
      disconnectSoon();
    };
  }, []);
}

export function useLiveStatus(): Status {
  const [s, setS] = useState<Status>(status);
  useEffect(() => {
    statusListeners.add(setS);
    return () => {
      statusListeners.delete(setS);
    };
  }, []);
  return s;
}
