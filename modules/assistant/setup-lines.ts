/**
 * Copy-paste setup for a coding agent, per agent. `{url}` and `{token}` are
 * filled in on screen. The lines are the ones the AHL platform gives interns
 * for its business memory (AHL repo, content/memory.ts), where each was run
 * with the agent named in `testedWith` on 2026-10-07 against the same GBrain
 * version behind the same kind of checked proxy. The suite's address speaks
 * the same protocol (MCP over Streamable HTTP, bearer token in a header);
 * see modules/assistant/EVIDENCE.md for what was run against the suite itself.
 */
export interface SetupLine {
  agent: string;
  lines: string;
  testedWith: string;
}

const TEMPLATES: SetupLine[] = [
  {
    agent: "Claude Code",
    lines: 'claude mcp add --transport http business-brain {url} --header "Authorization: Bearer {token}"',
    testedWith: "Claude Code 2.1.288",
  },
  {
    agent: "Codex",
    lines:
      '# keep this export in your shell profile: Codex reads the token from it each time it starts\nexport BUSINESS_BRAIN_TOKEN="{token}"\ncodex mcp add business-brain --url {url} --bearer-token-env-var BUSINESS_BRAIN_TOKEN',
    testedWith: "Codex CLI 0.160.1",
  },
  {
    agent: "Hermes",
    lines:
      '# add to ~/.hermes/config.yaml (if it already has mcp_servers:, put the entry under it)\nmcp_servers:\n  business-brain:\n    url: "{url}"\n    headers:\n      Authorization: "Bearer {token}"\n# then check: hermes mcp test business-brain',
    testedWith: "Hermes Agent 2026.9.24",
  },
  {
    agent: "OpenClaw",
    lines:
      'openclaw mcp add business-brain --url {url} --transport streamable-http --connect-timeout 30 --header "Authorization=Bearer {token}"\n# then check: openclaw mcp probe business-brain',
    testedWith: "OpenClaw 2026.9.8",
  },
];

export function setupLines(url: string, token: string): SetupLine[] {
  return TEMPLATES.map((t) => ({ ...t, lines: t.lines.replaceAll("{url}", url).replaceAll("{token}", token) }));
}
