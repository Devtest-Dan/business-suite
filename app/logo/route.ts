import { businessProfile } from "@/lib/settings";
import { fileRecord, readStoredFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** The business logo. Public: the sign-in page shows it before anyone signs in. */
export async function GET() {
  const { logoFileId } = await businessProfile();
  const row = logoFileId ? await fileRecord(logoFileId) : null;
  if (!row || !row.isPublic) return new Response("No logo is set.", { status: 404 });
  const bytes = await readStoredFile(row);
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": row.mime,
      "cache-control": "public, max-age=300",
      // An uploaded SVG must not run scripts.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
