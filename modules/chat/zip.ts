import { inflateRawSync } from "node:zlib";

/**
 * A small ZIP reader (stored and deflated entries, no ZIP64, no encryption):
 * enough for a Slack export, without adding a dependency. Guards against zip
 * bombs with limits on the number of entries and the unpacked size.
 */

export class ZipError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 300 * 1024 * 1024 };

export function readZip(bytes: Uint8Array, wanted: (name: string) => boolean = () => true, limits: ZipLimits = DEFAULT_LIMITS): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: the last 22..(22 + 65535) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This is not a ZIP file (or it is damaged). Upload the .zip file Slack gave you, unchanged.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("This ZIP uses the ZIP64 format, which the importer does not read. Export a smaller date range from Slack.");
  if (count > limits.maxEntries) throw new ZipError(`The ZIP has more than ${limits.maxEntries.toLocaleString("en")} files. Export a smaller date range from Slack.`);

  const out = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("The ZIP's table of contents is damaged. Download the export from Slack again.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !wanted(name)) continue;
    if (flags & 0x1) throw new ZipError("The ZIP is password-protected. Export it again from Slack without a password.");
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("The export unpacks to more than the importer handles in one go. Export a smaller date range from Slack.");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError("The ZIP is damaged. Download the export from Slack again.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) {
      const inflated = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      out.set(name, inflated);
    } else throw new ZipError(`The ZIP packs "${name}" in a way the importer does not read (method ${method}). Export it again from Slack.`);
  }
  return out;
}
