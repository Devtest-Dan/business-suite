import { z } from "zod";
import { getViewer } from "@/lib/auth/session";
import { fileRecord, readStoredFile } from "@/lib/storage";

/** Download a file. Any signed-in person may open a file by its id (ids are random and unguessable). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return new Response("Not found.", { status: 404 });
  const row = await fileRecord(id.data);
  if (!row) return new Response("Not found.", { status: 404 });
  if (!row.isPublic && !(await getViewer())) return new Response("Sign in first.", { status: 401 });
  const bytes = await readStoredFile(row);
  const inline = row.mime.startsWith("image/") && row.mime !== "image/svg+xml";
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": row.mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "cache-control": "private, max-age=300",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
