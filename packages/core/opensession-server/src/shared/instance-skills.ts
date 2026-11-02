/**
 * Instance skills: `SKILL.md` skills kept on this server and loaded by every
 * session, next to the ones a project's checkout carries. Shared between the
 * server store (server/instance-skills.ts) and Settings → Skills.
 *
 * The name and description rules are the Agent Skills ones the engine checks
 * when it loads a skill (lowercase a-z, 0-9 and single hyphens, at most 64
 * characters; a description of at most 1024 characters).
 */

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/** Why `name` is not a valid skill name, or null when it is. */
export function skillNameProblem(name: string): string | null {
  if (!name) return "Give the skill a name.";
  if (name.length > SKILL_NAME_MAX)
    return `Skill names are at most ${SKILL_NAME_MAX} characters.`;
  if (!/^[a-z0-9-]+$/.test(name))
    return "Use lowercase letters, numbers and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    return "Hyphens go between words, one at a time.";
  return null;
}

/** Where a listed skill lives. `instance` skills are editable here; `shipped`
 *  ones come with the server (or a package install) and are read only. */
export type SkillOrigin = "instance" | "shipped";

export interface SkillSummary {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Files in the skill's folder, SKILL.md included. Instance skills only. */
  fileCount?: number;
  /** Last change to any file in the skill (ISO). Instance skills only. */
  updatedAt?: string;
  /** An instance skill with the same name as a shipped one replaces it. */
  replacesShipped?: boolean;
}

export interface SkillFileInfo {
  /** Relative to the skill's folder, `/`-separated. */
  path: string;
  size: number;
  /** False for files that are not UTF-8 text; those can be replaced or
   *  removed, not edited. */
  text: boolean;
}

export interface InstanceSkillDetail {
  name: string;
  description: string;
  /** SKILL.md first, then the rest by path. */
  files: SkillFileInfo[];
  updatedAt: string;
  /** Where the folder lives on the server, for reference. */
  dir: string;
}

/** Upload limits, enforced by the server and shown in the UI. */
export const SKILL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const SKILL_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const SKILL_MAX_FILES = 500;
