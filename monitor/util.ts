import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

/** 16-hex-char SHA-256 prefix: short enough to read in diffs, long enough not to collide here. */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Collapse whitespace, drop zero-width characters, trim. */
export function normalizeText(s: string): string {
  return s
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \s]+/g, " ")
    .trim();
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function readJson<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} failed validation:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

/** Returns undefined if the file does not exist; throws if it exists but is invalid. */
export async function readJsonIfExists<T extends z.ZodType>(
  file: string,
  schema: T,
): Promise<z.infer<T> | undefined> {
  try {
    return await readJson(file, schema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Validates before writing so the repo never holds a file the dashboard can't read. */
export async function writeJson<T extends z.ZodType>(file: string, schema: T, data: z.infer<T>): Promise<void> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`refusing to write invalid ${file}:\n${formatZodError(parsed.error)}`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
}

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
