/** Settings → Skills (server: src/server/routes/instance-skills.ts). */

import type {
  InstanceSkillDetail,
  SkillSummary,
} from "../../../shared/instance-skills";
import { z } from "zod";
import { API_BASE, ApiError, request } from "./request";

const UPLOAD_RESPONSE = z.object({
  error: z.string().optional(),
  name: z.string().optional(),
  replaced: z.boolean().optional(),
});

const BASE = "/instance-skills";

function skillPath(name: string): string {
  return `${BASE}/${encodeURIComponent(name)}`;
}

export async function fetchSkills(): Promise<{
  skills: SkillSummary[];
  dir: string;
}> {
  const body = await request<{ skills?: SkillSummary[]; dir?: string }>(BASE, {
    label: "Failed to load skills",
  });
  return { skills: body?.skills ?? [], dir: body?.dir ?? "" };
}

export async function fetchSkill(name: string): Promise<InstanceSkillDetail> {
  const body = await request<{ skill: InstanceSkillDetail }>(skillPath(name), {
    label: "Failed to load the skill",
  });
  return body.skill;
}

export async function createSkill(
  name: string,
  description: string,
): Promise<InstanceSkillDetail> {
  const body = await request<{ skill: InstanceSkillDetail }>(BASE, {
    method: "POST",
    body: { name, description },
    label: "Failed to create the skill",
  });
  return body.skill;
}

export async function deleteSkill(name: string): Promise<void> {
  await request(skillPath(name), {
    method: "DELETE",
    label: "Failed to delete the skill",
  });
}

export async function fetchSkillFile(
  name: string,
  path: string,
): Promise<string> {
  const body = await request<{ content: string }>(
    `${skillPath(name)}/file?path=${encodeURIComponent(path)}`,
    { label: "Failed to open the file" },
  );
  return body.content;
}

/** Save (or add) one file. Returns the skill's name after the save, which
 *  changes when SKILL.md gives it a new one. */
export async function saveSkillFile(
  name: string,
  path: string,
  content: string,
): Promise<string> {
  const body = await request<{ name: string }>(`${skillPath(name)}/file`, {
    method: "PUT",
    body: { path, content },
    label: "Failed to save the file",
  });
  return body.name;
}

export async function deleteSkillFile(
  name: string,
  path: string,
): Promise<void> {
  await request(`${skillPath(name)}/file?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    label: "Failed to delete the file",
  });
}

/**
 * Upload one skill: a `.zip` or `.skill` archive, a lone `.md`, or every file
 * of a picked folder (each sent under its path inside the folder). A taken
 * name fails with status 409 unless `replace` is set.
 */
export async function uploadSkill(
  files: File[],
  opts: { replace?: boolean } = {},
): Promise<{ name: string; replaced: boolean }> {
  const form = new FormData();
  for (const file of files)
    form.append("file", file, file.webkitRelativePath || file.name);
  const res = await fetch(
    `${API_BASE}${BASE}/upload${opts.replace ? "?replace=1" : ""}`,
    { method: "POST", body: form },
  );
  const parsed = UPLOAD_RESPONSE.safeParse(await res.json().catch(() => null));
  const body = parsed.success ? parsed.data : null;
  if (!res.ok)
    throw new ApiError(
      body?.error || `Failed to upload the skill: ${res.status}`,
      res.status,
    );
  return { name: body?.name ?? "", replaced: body?.replaced === true };
}
