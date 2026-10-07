"use client";

import { useEffect, useState } from "react";

/**
 * A timezone picker. `zones` comes from the server (lib/format.ts timezones()) so the
 * list matches on both sides. With no saved value it switches to the browser's own
 * timezone once loaded.
 */
export function TimezoneSelect({ name, zones: known, defaultValue }: { name: string; zones: string[]; defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue || "UTC");
  useEffect(() => {
    if (defaultValue) return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's timezone is only known after hydration
    if (local && known.includes(local)) setValue(local);
  }, [defaultValue, known]);
  const zones = known.includes(value) ? known : [value, ...known];
  return (
    <select name={name} value={value} onChange={(e) => setValue(e.target.value)} className="input" required>
      {zones.map((z) => (
        <option key={z} value={z}>
          {z.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}
