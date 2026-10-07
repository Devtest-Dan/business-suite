import { z } from "zod";
import { getViewer, can } from "@/lib/auth/session";
import { messageFor } from "@/lib/errors";
import { saveFile } from "@/lib/storage";

/**
 * Upload one file (multipart field "file", optional "module"). Modules call
 * this from their forms and keep the returned id. Needs "files.upload".
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(viewer, "files.upload"))) return Response.json({ error: "Your role cannot upload files. Ask the owner." }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Send the file in a form field called “file”." }, { status: 400 });
  const moduleId = z.string().regex(/^[a-z][a-z0-9-]*$/).nullable().catch(null).parse(form?.get("module") ?? null);
  try {
    const saved = await saveFile({ name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), module: moduleId }, viewer.id);
    return Response.json({ file: saved });
  } catch (error) {
    return Response.json({ error: messageFor(error) }, { status: 400 });
  }
}
