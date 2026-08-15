import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "./types.ts";

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(source: string): Frontmatter {
  const normalized = source.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return { fields: {}, body: normalized };

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: normalized };

  const header = normalized.slice(3, end);
  const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1);
  const fields: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  return { fields, body };
}

/** Load every `*.md` skill in a directory. A skill's frontmatter carries its name, description and triggers. */
export function loadSkills(dir: string): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;

    const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));
    skills.push({
      name: fields.name ?? name.replace(/\.md$/, ""),
      description: fields.description ?? "",
      triggers: (fields.triggers ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      body,
      path,
    });
  }
  return skills;
}

/** Select the skills whose triggers appear in the prompt; fall back to all of them. */
export function selectSkills(skills: Skill[], prompt: string, limit = 4): Skill[] {
  const lower = prompt.toLowerCase();
  const scored = skills
    .map((skill) => ({
      skill,
      score: skill.triggers.reduce((n, t) => (t && lower.includes(t.toLowerCase()) ? n + 1 : n), 0),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return skills.slice(0, limit);
  return scored.slice(0, limit).map((s) => s.skill);
}
