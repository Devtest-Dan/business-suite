/** An error whose message is written for the person using the suite and is safe to show. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export const SERVER_FAILURE =
  "The server could not finish this. It may not have been saved: check, then try again; if it keeps happening, the owner can read the server log (docs/DEPLOY.md, \"Reading the logs\").";

export function messageFor(error: unknown): string {
  return error instanceof UserError ? error.message : SERVER_FAILURE;
}
