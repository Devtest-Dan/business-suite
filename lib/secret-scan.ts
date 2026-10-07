/** One key-like string found in a text: where it was and what kind it looked like. */
export interface SecretFinding {
  path: string;
  line: number;
  kind: string;
}

/**
 * The secret scanner (pure). Copied from the AI Harness Labs app (our own code).
 */
const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "live or project API key (sk-…)", pattern: /\bsk[-_](?:live|test|proj|ant)[-_A-Za-z0-9]{6,}/g },
  { kind: "API key (sk-…)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "agent token (agt_…)", pattern: /\bagt_[A-Za-z0-9_-]{43}/g },
  { kind: "credential assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}["']?/gi },
];

/** Finds key-like strings and returns the text with each one replaced by a marker. */
export function scanSecrets(path: string, text: string): { redacted: string; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let redacted = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string, offset: number, whole: string) => {
      const line = whole.slice(0, offset).split("\n").length;
      if (!findings.some((f) => f.line === line)) findings.push({ path, line, kind });
      return `[REDACTED ${kind}]`;
    });
  }
  return { redacted, findings };
}
