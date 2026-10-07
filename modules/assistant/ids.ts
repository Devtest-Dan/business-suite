/** The module's id and permission keys, in one place (client-safe). */
export const MODULE_ID = "assistant";

export const P = {
  /** The shell's own permission for the chat (defined in lib/permissions.ts). */
  use: "assistant.use",
  recall: "assistant.recall",
  remember: "assistant.remember",
  curate: "assistant.curate",
  import: "assistant.import",
  agents: "assistant.agents",
  limits: "assistant.limits",
} as const;
