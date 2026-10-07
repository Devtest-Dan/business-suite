/** Splits "a/:id/edit" into segments ("" is the module's home page). */
export function routeSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Finds the route for the URL segments after /m/<id>/. Static segments win
 * over ":param" ones, so "new" is never read as an id.
 */
export function matchRoute<R extends { path: string }>(routes: R[], segments: string[]): { route: R; params: Record<string, string> } | null {
  const ranked = routes
    .map((route) => ({ route, parts: routeSegments(route.path) }))
    .filter(({ parts }) => parts.length === segments.length)
    .sort((a, b) => score(b.parts) - score(a.parts));
  for (const { route, parts } of ranked) {
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const value = segments[i];
      if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
      else if (part !== value) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

function score(parts: string[]): number {
  return parts.reduce((s, p, i) => s + (p.startsWith(":") ? 0 : 2 ** (parts.length - i)), 0);
}
