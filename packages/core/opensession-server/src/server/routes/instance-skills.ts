/**
 * /api/instance-skills: Settings → Skills. List, create, upload, edit and
 * delete the skills every session loads next to its checkout's own
 * (server/instance-skills.ts).
 *
 * Reads are open to the app like the rest of Settings. Writes refuse the
 * automation principal: a skill is text every later session reads, so an
 * automation that could write one could steer all of them.
 */

import { auditAsync } from "../audit";
import {
  createInstanceSkill,
  deleteInstanceSkill,
  deleteInstanceSkillFile,
  importInstanceSkill,
  listSkills,
  readInstanceSkill,
  readInstanceSkillFile,
  SkillStoreError,
  writeInstanceSkillFile,
  type UploadedFile,
} from "../instance-skills";
import { instanceSkillsDir } from "../skill-paths";
import { invalidateSkillIndex } from "../skills";
import { SKILL_UPLOAD_MAX_BYTES } from "../../shared/instance-skills";
import {
  isAutomationPrincipal,
  requestUser,
  type RouteContext,
} from "./context";

const PREFIX = "/api/instance-skills";
/** Multipart framing on top of the files themselves. */
const UPLOAD_OVERHEAD_BYTES = 1024 * 1024;

function fail(error: unknown): Response {
  if (error instanceof SkillStoreError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof URIError)
    return Response.json({ error: "Not a valid skill name." }, { status: 400 });
  console.error("[instance-skills]", error);
  return Response.json(
    { error: "The skill could not be saved. Try again." },
    { status: 500 },
  );
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SkillStoreError("Expected a JSON object.");
  return body as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new SkillStoreError(`${field} must be text.`);
  return value;
}

/** Changed skills reach the "/" menu at once and the audit log as one line. */
function changed(ctx: RouteContext, action: string, detail: object) {
  invalidateSkillIndex();
  auditAsync({
    msg: "instance_skill_" + action,
    user: requestUser(ctx),
    ...detail,
  });
}

export async function handleInstanceSkillsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;
  if (path !== PREFIX && !path.startsWith(PREFIX + "/")) return undefined;

  const write = req.method !== "GET" && req.method !== "HEAD";
  if (write && isAutomationPrincipal(ctx))
    return Response.json(
      { error: "Automations cannot change instance skills." },
      { status: 403 },
    );

  const rest = path.slice(PREFIX.length + 1);
  const [rawName, sub, ...extra] = rest ? rest.split("/") : [];
  if (extra.length) return undefined;

  try {
    const name = rawName ? decodeURIComponent(rawName) : "";
    if (!name) {
      if (req.method === "GET")
        return Response.json({
          skills: await listSkills(),
          dir: instanceSkillsDir(),
        });
      if (req.method === "POST") {
        const body = await jsonBody(req);
        const skill = await createInstanceSkill(
          text(body.name, "name").trim(),
          text(body.description ?? "", "description"),
        );
        changed(ctx, "created", { skill: skill.name });
        return Response.json({ skill }, { status: 201 });
      }
      return undefined;
    }

    if (name === "upload" && !sub && req.method === "POST") {
      const length = Number(req.headers.get("content-length"));
      if (
        Number.isFinite(length) &&
        length > SKILL_UPLOAD_MAX_BYTES + UPLOAD_OVERHEAD_BYTES
      )
        throw new SkillStoreError("The upload is larger than the limit.", 413);
      const form = await req.formData().catch(() => null);
      if (!form) throw new SkillStoreError("Expected a file upload.");
      const files: UploadedFile[] = [];
      for (const entry of form.getAll("file")) {
        if (typeof entry === "string") continue;
        files.push({
          path: entry.name,
          bytes: new Uint8Array(await entry.arrayBuffer()),
        });
      }
      const result = await importInstanceSkill(files, {
        replace: url.searchParams.get("replace") === "1",
      });
      changed(ctx, result.replaced ? "replaced" : "uploaded", {
        skill: result.name,
        files: files.length,
      });
      return Response.json(result, { status: result.replaced ? 200 : 201 });
    }

    if (!sub) {
      if (req.method === "GET")
        return Response.json({ skill: await readInstanceSkill(name) });
      if (req.method === "DELETE") {
        await deleteInstanceSkill(name);
        changed(ctx, "deleted", { skill: name });
        return Response.json({ ok: true });
      }
      return undefined;
    }

    if (sub === "file") {
      if (req.method === "GET") {
        const filePath = url.searchParams.get("path") || "";
        return Response.json({
          path: filePath,
          content: await readInstanceSkillFile(name, filePath),
        });
      }
      if (req.method === "PUT") {
        const body = await jsonBody(req);
        const filePath = text(body.path, "path");
        const result = await writeInstanceSkillFile(
          name,
          filePath,
          text(body.content, "content"),
        );
        changed(ctx, "file_saved", {
          skill: result.name,
          path: filePath,
          ...(result.name !== name ? { renamedFrom: name } : {}),
        });
        return Response.json(result);
      }
      if (req.method === "DELETE") {
        const filePath = url.searchParams.get("path") || "";
        await deleteInstanceSkillFile(name, filePath);
        changed(ctx, "file_deleted", { skill: name, path: filePath });
        return Response.json({ ok: true });
      }
    }
    return undefined;
  } catch (error) {
    return fail(error);
  }
}
