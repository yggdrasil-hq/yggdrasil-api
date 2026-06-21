export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export async function uniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const normalized = slugify(base) || "item";
  if (!(await isTaken(normalized))) {
    return normalized;
  }

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${normalized}-${i}`;
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error("Unable to generate unique slug");
}
