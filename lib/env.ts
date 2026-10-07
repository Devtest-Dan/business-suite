import "server-only";
import pkg from "@/package.json";

/**
 * Everything the server reads from its environment, in one place.
 * deploy/install.sh writes these into /opt/business-suite/.env; for local
 * development copy .env.example to .env.local.
 */
export interface SuiteEnv {
  databaseUrl: string;
  /** 32 random bytes (base64). Encrypts stored keys and passwords. */
  secretKey: string;
  /** The public address, e.g. https://suite.example.com (no trailing slash). */
  publicUrl: string;
  /** When set, the first-run setup page asks for it before creating the owner. */
  setupCode: string;
  filesDir: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
  version: string;
}

function read(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function env(): SuiteEnv {
  const databaseUrl = read("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local (development) or /opt/business-suite/.env (server).");
  }
  const endpoint = read("FILES_S3_ENDPOINT");
  return {
    databaseUrl,
    secretKey: read("SUITE_SECRET_KEY"),
    publicUrl: (read("SUITE_URL") || "http://localhost:3081").replace(/\/+$/, ""),
    setupCode: read("SUITE_SETUP_CODE"),
    filesDir: read("SUITE_FILES_DIR") || "./data/files",
    s3: endpoint
      ? {
          endpoint: endpoint.replace(/\/+$/, ""),
          region: read("FILES_S3_REGION") || "auto",
          bucket: read("FILES_S3_BUCKET"),
          accessKeyId: read("FILES_S3_ACCESS_KEY_ID"),
          secretAccessKey: read("FILES_S3_SECRET_ACCESS_KEY"),
        }
      : null,
    version: pkg.version,
  };
}

/** True when cookies should carry the Secure flag. */
export function isHttps(): boolean {
  return env().publicUrl.startsWith("https://");
}
