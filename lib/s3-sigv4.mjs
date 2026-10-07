// A minimal S3 client (AWS Signature Version 4, path-style URLs) that works
// with any S3-compatible storage: AWS S3, Cloudflare R2, Backblaze B2, Wasabi,
// MinIO, Hetzner Object Storage and others. Plain JavaScript so the backup
// script can use it without TypeScript; lib/storage uses it too.
// Only PUT, GET, HEAD and DELETE of single objects: nothing else is needed.

import { createHash, createHmac } from "node:crypto";

/** @typedef {{ endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string }} S3Config */

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const hex = (data) => createHash("sha256").update(data).digest("hex");

function encodeKey(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * Signs a request. Exported for the unit test (checked against AWS's
 * published example signature).
 * @param {{ method: string, url: URL, region: string, accessKeyId: string, secretAccessKey: string, headers?: Record<string, string>, payloadHash?: string, now?: Date, service?: string }} req
 */
export function signRequest(req) {
  const service = req.service ?? "s3";
  const now = req.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = req.payloadHash ?? "UNSIGNED-PAYLOAD";
  const headers = { ...(req.headers ?? {}), host: req.url.host, "x-amz-date": amzDate };
  if (service === "s3") headers["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    req.method,
    req.url.pathname || "/",
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${req.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${req.secretAccessKey}`, day), req.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "host")),
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** @param {S3Config} config @param {string} key */
function objectUrl(config, key) {
  return new URL(`${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`);
}

async function send(config, method, key, { body, headers = {}, length } = {}) {
  const url = objectUrl(config, key);
  const extra = { ...headers };
  if (length !== undefined) extra["content-length"] = String(length);
  const signed = signRequest({ method, url, region: config.region || "auto", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, headers: extra });
  const init = { method, headers: signed, body };
  if (body && typeof body.getReader === "function") init.duplex = "half";
  const res = await fetch(url, init);
  if (!res.ok && !(method === "DELETE" && res.status === 404) && !(method === "HEAD" && res.status === 404)) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 ${method} ${key} failed with ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

/** @param {S3Config} config @param {string} key @param {Uint8Array | ReadableStream} body @param {{ contentType?: string, length?: number }} [options] */
export async function s3Put(config, key, body, options = {}) {
  const length = options.length ?? (body instanceof Uint8Array ? body.byteLength : undefined);
  await send(config, "PUT", key, { body, length, headers: options.contentType ? { "content-type": options.contentType } : {} });
}

/** @param {S3Config} config @param {string} key @returns {Promise<Response>} */
export async function s3Get(config, key) {
  return send(config, "GET", key);
}

/** @param {S3Config} config @param {string} key */
export async function s3Delete(config, key) {
  await send(config, "DELETE", key);
}

/** @param {S3Config} config @param {string} key @returns {Promise<boolean>} */
export async function s3Exists(config, key) {
  const res = await send(config, "HEAD", key);
  return res.ok;
}
