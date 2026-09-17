import { createHash } from "node:crypto";

/**
 * ADR 025: validation for an uploaded Pi extension bundle.
 *
 * This module is deliberately pure and has no database or HTTP imports, for
 * one reason: it is the only thing standing between a client-supplied file
 * list and `fs.writeFileSync` inside a job container that holds a live
 * GitHub installation token. Every rule here is about not letting a bundle
 * describe a write outside the directory the container owns. A path-traversal
 * or write-outside-the-sandbox bug would live exactly here, so it is tested
 * directly and exhaustively (bundle.test.ts) rather than only through a route.
 *
 * The container re-runs the same path checks (agent-images' pi bundle
 * installer) rather than trusting the API's output. Two checks of the same
 * thing is not redundancy when the second one is the code that actually
 * touches the filesystem.
 */

/**
 * Caps. Chosen together on one governing constraint: **an upload must be
 * deliverable**. The bundle reaches the pod as a single environment variable
 * (the only file-delivery path the Orchestrator has — the same one ADR
 * 008's ADR_MARKDOWN and test-spec markdown already use), and a pod spec that
 * exceeds Kubernetes' object-size limit is rejected wholesale at admission,
 * which would look like "the job never started" rather than "the upload was
 * too big". Rejecting at upload time converts that into a clear 400 at the
 * moment someone can act on it.
 *
 * maxFileBytes is the least arbitrary of these: a single-hand-written Pi
 * extension module that is larger than 64 KiB is almost certainly not one.
 *
 * There is deliberately no separate per-project extension *count* cap. The
 * opt-in is declared per project (item 7) but the selection is not: a project
 * loads every active extension of its organization. That makes the
 * organization cap the effective per-project cap by construction, which is one
 * fewer limit to keep consistent — at the cost of not being able to run one
 * project with a subset. Per-project selection is a documented follow-up.
 */
export const EXTENSION_LIMITS = {
  /** Files in one extension. */
  maxFiles: 16,
  /** One file, measured in UTF-8 bytes. */
  maxFileBytes: 64 * 1024,
  /**
   * One extension, all files, measured in UTF-8 bytes.
   *
   * Sized so that the delivery payload cannot be exceeded by *storing* too
   * much: every active extension of an organization is loaded into each
   * opted-in project (item 7's blunt model), so the worst case is
   * `maxPerOrganization * maxTotalBytes` plus per-extension JSON overhead, and
   * that must stay under `maxEncodedBytes`: 5 * 96 KiB = 480 KiB, + ~1 KiB of
   * overhead, < 512 KiB. The delivery route re-checks it anyway, because an
   * invariant that only holds by arithmetic is one a future limit change can
   * silently break.
   */
  maxTotalBytes: 96 * 1024,
  /** The encoded delivery payload for one project's enabled extensions. */
  maxEncodedBytes: 512 * 1024,
  /** Extensions stored per organization — and therefore the per-project cap too. */
  maxPerOrganization: 5,
  /** Longest accepted path, matching the column width. */
  maxPathLength: 256,
} as const;

/**
 * File types a bundle may contain. Deliberately short: Pi extensions are
 * TypeScript/JavaScript modules, and a package.json lets an extension describe
 * itself. Anything else would either be inert (so why store it?) or something
 * the container should not be writing at all.
 */
export const ALLOWED_FILE_EXTENSIONS = [".ts", ".js", ".json"] as const;

/** Where Pi is pointed when a bundle does not say. */
export const DEFAULT_ENTRY_PATH = "src/index.ts";

/**
 * Tool names owned by the baked-in `yggdrasil-contract` extension (ADR 004),
 * which is what makes the Orchestrator's turn/completion protocol work: the
 * agent's real result is a *tool call*, and `terminate: true` on it is the
 * authoritative "this run is over" signal (see
 * agent-images/docs/concepts/contract-extension.md).
 *
 * An uploaded extension that re-declares one of these could therefore confuse
 * or forge that protocol. Uploads that mention these names are refused.
 *
 * This is a **heuristic guard, not a guarantee** — a determined upload can
 * build the string at runtime and evade a static scan. It is here because it
 * reliably catches the realistic case (someone ships an extension that wraps
 * or redefines `ask_user`) and because refusing the obvious version costs
 * nothing. ADR 025 is explicit that it does not make uploads safe.
 */
export const RESERVED_CONTRACT_TOOL_NAMES = [
  "ask_user",
  "submit_adr",
  "submit_build_result",
  "request_action_item",
  "report_test_step",
  "submit_test_report",
  "submit_review",
  "update_design_preview",
  "submit_design",
] as const;

/** Dependency fields that would require a package manager at run time. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface BundleFileInput {
  path: unknown;
  content: unknown;
}

export interface BundleInput {
  entryPath?: unknown;
  files: unknown;
}

export interface ValidatedBundleFile {
  path: string;
  content: string;
  sizeBytes: number;
}

export interface ValidatedBundle {
  entryPath: string;
  files: ValidatedBundleFile[];
  totalBytes: number;
  sha256: string;
}

export type BundleValidation =
  | { ok: true; bundle: ValidatedBundle }
  | { ok: false; error: string };

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Validate one bundle-relative path.
 *
 * Rejects, in order: non-strings, empty/whitespace-padded values, absolute
 * paths, any backslash (a Windows-style separator is never legitimate here and
 * is the usual way a "safety" check gets confused), NUL and control
 * characters, `.`/`..` segments, paths that are not already in normal form,
 * non-allowlisted extensions, and anything longer than the column allows.
 *
 * Returning the string rather than a boolean is deliberate: callers store the
 * returned value, so a caller cannot accidentally use the unvalidated input.
 */
export function validateFilePath(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return invalid("File path must be a string");
  const path = raw;
  if (path.length === 0) return invalid("File path must not be empty");
  if (path !== path.trim()) return invalid(`File path "${path}" must not have surrounding whitespace`);
  if (path.length > EXTENSION_LIMITS.maxPathLength) {
    return invalid(`File path "${path}" exceeds ${EXTENSION_LIMITS.maxPathLength} characters`);
  }
  if (path.startsWith("/")) return invalid(`File path "${path}" must be relative, not absolute`);
  if (/^[A-Za-z]:/.test(path)) return invalid(`File path "${path}" must not be a drive path`);
  if (path.includes("\\")) return invalid(`File path "${path}" must use "/" separators only`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return invalid(`File path "${path}" must not contain control characters`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) {
    return invalid(`File path "${path}" must not contain empty segments`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return invalid(`File path "${path}" must not contain "." or ".." segments`);
  }

  const lower = path.toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return invalid(
      `File path "${path}" must end with one of: ${ALLOWED_FILE_EXTENSIONS.join(", ")}`,
    );
  }

  return { ok: true, path };
}

/**
 * Validate and normalize a whole bundle.
 *
 * Order of checks is intentional: paths first (cheapest, and the only
 * security-relevant class), then sizes, then content-level rules — so a
 * bundle that is both oversized and unsafe reports the unsafe part.
 */
export function validateExtensionBundle(input: BundleInput): BundleValidation {
  if (typeof input !== "object" || input === null) {
    return invalid("Bundle must be an object");
  }
  if (!Array.isArray(input.files)) {
    return invalid("Bundle must have a files array");
  }
  if (input.files.length === 0) {
    return invalid("Bundle must contain at least one file");
  }
  if (input.files.length > EXTENSION_LIMITS.maxFiles) {
    return invalid(`Bundle may contain at most ${EXTENSION_LIMITS.maxFiles} files`);
  }

  const files: ValidatedBundleFile[] = [];
  const seen = new Set<string>();

  for (const raw of input.files) {
    if (typeof raw !== "object" || raw === null) {
      return invalid("Each file must be an object");
    }
    const file = raw as BundleFileInput;

    const pathResult = validateFilePath(file.path);
    if (!pathResult.ok) return invalid(pathResult.error);
    const path = pathResult.path;

    // Duplicate paths would make the stored set ambiguous and the sha256
    // order-dependent in a way a reader could not reconstruct.
    if (seen.has(path)) return invalid(`Duplicate file path "${path}"`);
    seen.add(path);

    if (typeof file.content !== "string") {
      return invalid(`Content of "${path}" must be a string`);
    }
    if (file.content.includes("\u0000")) {
      return invalid(`Content of "${path}" must not contain NUL bytes`);
    }

    const sizeBytes = Buffer.byteLength(file.content, "utf8");
    if (sizeBytes > EXTENSION_LIMITS.maxFileBytes) {
      return invalid(
        `File "${path}" is ${sizeBytes} bytes, over the ${EXTENSION_LIMITS.maxFileBytes}-byte limit`,
      );
    }

    if (path.toLowerCase().endsWith(".json")) {
      const jsonError = validateJsonFile(path, file.content);
      if (jsonError) return invalid(jsonError);
    } else {
      // Code files only: JSON cannot declare a tool, so scanning it would
      // only produce false positives (a description mentioning a tool name).
      const reserved = findReservedToolName(file.content);
      if (reserved) {
        return invalid(
          `File "${path}" names the reserved contract tool "${reserved}", which an uploaded extension may not redefine`,
        );
      }
    }

    files.push({ path, content: file.content, sizeBytes });
  }

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > EXTENSION_LIMITS.maxTotalBytes) {
    return invalid(
      `Bundle is ${totalBytes} bytes, over the ${EXTENSION_LIMITS.maxTotalBytes}-byte limit`,
    );
  }

  const entryPath = typeof input.entryPath === "string" && input.entryPath.length > 0
    ? input.entryPath
    : DEFAULT_ENTRY_PATH;
  const entryResult = validateFilePath(entryPath);
  if (!entryResult.ok) return invalid(`Entry path: ${entryResult.error}`);
  if (!seen.has(entryResult.path)) {
    return invalid(`Entry path "${entryResult.path}" is not one of the bundle's files`);
  }
  if (entryResult.path.toLowerCase().endsWith(".json")) {
    return invalid(`Entry path "${entryResult.path}" must be a .ts or .js module, not JSON`);
  }

  // Sorted so the digest is a function of the *set*, not of the order the
  // client happened to send it in — otherwise two identical bundles would
  // have different hashes and the revision pin would be meaningless.
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    ok: true,
    bundle: {
      entryPath: entryResult.path,
      files: sorted,
      totalBytes,
      sha256: hashBundle(sorted),
    },
  };
}

/** A package.json is allowed, but must be self-describing and dependency-free. */
function validateJsonFile(path: string, content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return `File "${path}" is not valid JSON`;
  }
  if (!path.toLowerCase().endsWith("package.json")) return null;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `File "${path}" must contain a JSON object`;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `File "${path}": "${field}" must be an object`;
    }
    if (Object.keys(value).length > 0) {
      // Nothing installs dependencies inside a job pod, so an extension that
      // declares them would fail at runtime rather than at upload. Refusing
      // here keeps "what stored successfully" equal to "what can actually run".
      return `File "${path}": "${field}" must be empty — uploaded extensions cannot install dependencies`;
    }
  }
  return null;
}

/**
 * First reserved contract tool name that appears as a *string literal* in the
 * source, if any.
 *
 * Matching quoted text rather than a plain substring is what keeps this from
 * rejecting an honest extension that merely mentions a tool in a comment or a
 * doc string, while still catching the realistic case: declaring a tool means
 * naming it in a string (`registerTool({ name: "ask_user" })`). It is a
 * heuristic and ADR 025 says so — a literal can still be assembled at run
 * time to evade it.
 */
export function findReservedToolName(content: string): string | null {
  for (const name of RESERVED_CONTRACT_TOOL_NAMES) {
    const literal = new RegExp(`["'\`]${name}["'\`]`);
    if (literal.test(content)) return name;
  }
  return null;
}

/**
 * Canonical digest over the file set. Length-prefixing each field keeps
 * distinct file sets from colliding on a concatenation boundary (e.g. a file
 * whose content ends where the next path begins).
 */
export function hashBundle(files: Array<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(file.path, "utf8")}:${file.path}`);
    hash.update(`${Buffer.byteLength(file.content, "utf8")}:`);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/**
 * The delivery payload: one JSON string, carried in the pod env under
 * PI_EXTENSIONS_BUNDLE, which the container's installer reads. Keeping the
 * encoding here means the API and the container cannot disagree about it, and
 * the size check is against the exact bytes that will be shipped.
 */
export interface DeliveredExtension {
  slug: string;
  entryPath: string;
  sha256: string;
  files: Array<{ path: string; content: string }>;
}

export interface EncodedBundle {
  /** Value for PI_EXTENSIONS_BUNDLE. */
  value: string;
  byteSize: number;
}

export function encodeExtensionBundle(extensions: DeliveredExtension[]): EncodedBundle {
  const value = JSON.stringify({ version: 1, extensions });
  return { value, byteSize: Buffer.byteLength(value, "utf8") };
}
