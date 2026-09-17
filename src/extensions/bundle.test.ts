import { describe, expect, it } from "vitest";
import {
  ALLOWED_FILE_EXTENSIONS,
  DEFAULT_ENTRY_PATH,
  EXTENSION_LIMITS,
  encodeExtensionBundle,
  findReservedToolName,
  hashBundle,
  validateExtensionBundle,
  validateFilePath,
} from "./bundle.js";

/**
 * ADR 025. This module is the only thing between a client-supplied file list
 * and a write inside a container holding the project's GitHub installation
 * token, so it is tested directly and exhaustively rather than only through a
 * route. The path cases below are the point of the whole file.
 */

function bundle(files: Array<{ path: unknown; content: unknown }>, entryPath?: unknown) {
  return validateExtensionBundle({ entryPath, files });
}

describe("validateFilePath", () => {
  it("accepts an ordinary relative module path", () => {
    const result = validateFilePath("src/index.ts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("src/index.ts");
  });

  it("accepts nested paths and a root-level module", () => {
    expect(validateFilePath("src/tools/helper.ts").ok).toBe(true);
    expect(validateFilePath("index.ts").ok).toBe(true);
  });

  it("accepts every allowlisted extension", () => {
    for (const extension of ALLOWED_FILE_EXTENSIONS) {
      expect(validateFilePath(`src/module${extension}`).ok).toBe(true);
    }
  });

  // --- traversal / escape attempts: the security-relevant set ---
  it("rejects absolute paths", () => {
    expect(validateFilePath("/etc/passwd").ok).toBe(false);
    expect(validateFilePath("/root/.pi/agent/extensions/x.ts").ok).toBe(false);
  });

  it("rejects drive-letter paths", () => {
    expect(validateFilePath("C:/evil.ts").ok).toBe(false);
  });

  it("rejects backslash separators, including Windows-style traversal", () => {
    expect(validateFilePath("src\\index.ts").ok).toBe(false);
    expect(validateFilePath("..\\..\\evil.ts").ok).toBe(false);
  });

  it("rejects any '..' segment, wherever it sits", () => {
    expect(validateFilePath("../evil.ts").ok).toBe(false);
    expect(validateFilePath("src/../../evil.ts").ok).toBe(false);
    expect(validateFilePath("src/../index.ts").ok).toBe(false);
    expect(validateFilePath("..").ok).toBe(false);
  });

  it("rejects '.' segments and empty segments", () => {
    expect(validateFilePath("./index.ts").ok).toBe(false);
    expect(validateFilePath("src//index.ts").ok).toBe(false);
    expect(validateFilePath("src/./index.ts").ok).toBe(false);
  });

  it("rejects control characters and NUL", () => {
    expect(validateFilePath("src/in\u0000dex.ts").ok).toBe(false);
    expect(validateFilePath("src/in\ndex.ts").ok).toBe(false);
  });

  it("rejects surrounding whitespace (a trimming mismatch would store one path and write another)", () => {
    expect(validateFilePath(" src/index.ts").ok).toBe(false);
    expect(validateFilePath("src/index.ts ").ok).toBe(false);
  });

  it("rejects empty and non-string paths", () => {
    expect(validateFilePath("").ok).toBe(false);
    expect(validateFilePath(undefined).ok).toBe(false);
    expect(validateFilePath(42).ok).toBe(false);
    expect(validateFilePath(null).ok).toBe(false);
  });

  it("rejects paths over the column width", () => {
    expect(validateFilePath(`src/${"a".repeat(EXTENSION_LIMITS.maxPathLength)}.ts`).ok).toBe(false);
  });

  it("rejects extensions outside the allowlist", () => {
    for (const path of ["src/run.sh", "src/blob.bin", "src/notes.md", "src/index"]) {
      expect(validateFilePath(path).ok).toBe(false);
    }
  });
});

describe("validateExtensionBundle", () => {
  it("accepts a minimal single-file bundle and defaults the entry path", () => {
    const result = bundle([{ path: DEFAULT_ENTRY_PATH, content: "export default () => {};" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.entryPath).toBe(DEFAULT_ENTRY_PATH);
    expect(result.bundle.files).toHaveLength(1);
  });

  it("honours an explicit entry path", () => {
    const result = bundle(
      [
        { path: "index.ts", content: "export default () => {};" },
        { path: "src/extra.ts", content: "export const x = 1;" },
      ],
      "index.ts",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.entryPath).toBe("index.ts");
  });

  it("rejects an entry path that is not in the bundle", () => {
    const result = bundle([{ path: "src/other.ts", content: "x" }], "src/index.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not one of the bundle's files");
  });

  it("rejects a JSON entry path (Pi needs a module to load)", () => {
    const result = bundle(
      [
        { path: "package.json", content: "{}" },
        { path: "src/index.ts", content: "x" },
      ],
      "package.json",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be a .ts or .js module");
  });

  it("rejects a traversing path nested inside an otherwise valid bundle", () => {
    const result = bundle([
      { path: "src/index.ts", content: "x" },
      { path: "../../../root/.ssh/authorized_keys", content: "ssh-rsa AAAA" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate paths", () => {
    const result = bundle([
      { path: "src/index.ts", content: "a" },
      { path: "src/index.ts", content: "b" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Duplicate");
  });

  it("rejects non-string and NUL-bearing content", () => {
    expect(bundle([{ path: "src/index.ts", content: 123 }]).ok).toBe(false);
    expect(bundle([{ path: "src/index.ts", content: "a\u0000b" }]).ok).toBe(false);
  });

  it("rejects an empty file list and a missing files array", () => {
    expect(bundle([]).ok).toBe(false);
    expect(validateExtensionBundle({ files: undefined }).ok).toBe(false);
    expect(validateExtensionBundle({ files: [] }).ok).toBe(false);
  });

  it("rejects more files than the cap", () => {
    const files = Array.from({ length: EXTENSION_LIMITS.maxFiles + 1 }, (_, index) => ({
      path: `src/file${index}.ts`,
      content: "x",
    }));
    const result = validateExtensionBundle({ entryPath: "src/file0.ts", files });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most");
  });

  it("enforces the per-file byte cap using UTF-8 size, not character count", () => {
    const multibyte = "\u00e9".repeat(EXTENSION_LIMITS.maxFileBytes); // 2 bytes per char
    const result = bundle([{ path: "src/index.ts", content: multibyte }]);
    expect(result.ok).toBe(false);

    const withinCap = "a".repeat(EXTENSION_LIMITS.maxFileBytes);
    expect(bundle([{ path: "src/index.ts", content: withinCap }]).ok).toBe(true);
  });

  it("enforces the total bundle cap", () => {
    // Five files at the per-file cap: each is individually acceptable, but
    // 5 x maxFileBytes exceeds maxTotalBytes. (A single file can never trip
    // this cap on its own, since the per-file cap is smaller.)
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `src/file${index}.ts`,
      content: "a".repeat(EXTENSION_LIMITS.maxFileBytes),
    }));
    const result = validateExtensionBundle({ entryPath: "src/file0.ts", files });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("over the");
  });

  // --- package.json: source-only, so dependencies are refused ---
  it("accepts a dependency-free package.json", () => {
    const result = bundle([
      { path: "src/index.ts", content: "x" },
      { path: "package.json", content: JSON.stringify({ name: "my-ext", type: "module" }) },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects a package.json declaring dependencies (nothing would install them)", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const result = bundle([
        { path: "src/index.ts", content: "x" },
        { path: "package.json", content: JSON.stringify({ [field]: { typebox: "1.1.38" } }) },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("accepts empty dependency objects", () => {
    const result = bundle([
      { path: "src/index.ts", content: "x" },
      { path: "package.json", content: JSON.stringify({ dependencies: {}, devDependencies: {} }) },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects malformed JSON in a .json file", () => {
    const result = bundle([
      { path: "src/index.ts", content: "x" },
      { path: "package.json", content: "{ not json" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  // --- the contract-extension guard ---
  it("rejects source that names a reserved contract tool", () => {
    const result = bundle([
      { path: "src/index.ts", content: `registerTool({ name: "ask_user" });` },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ask_user");
  });

  it("rejects every reserved tool name when quoted", () => {
    for (const name of [
      "ask_user",
      "submit_adr",
      "submit_build_result",
      "request_action_item",
      "report_test_step",
      "submit_test_report",
      "submit_review",
      "update_design_preview",
      "submit_design",
    ]) {
      const result = bundle([{ path: "src/index.ts", content: `const t = '${name}';` }]);
      expect(result.ok).toBe(false);
    }
  });

  it("allows a comment that merely mentions a tool name unquoted", () => {
    const result = bundle([
      { path: "src/index.ts", content: "// does not touch ask_user; purely additive\n" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("does not scan JSON for tool names (a description is not a declaration)", () => {
    const result = bundle([
      { path: "src/index.ts", content: "x" },
      { path: "package.json", content: JSON.stringify({ description: "wraps ask_user" }) },
    ]);
    expect(result.ok).toBe(true);
  });

  // --- canonical hashing ---
  it("hashes to the same digest regardless of file order", () => {
    const a = bundle(
      [
        { path: "src/a.ts", content: "a" },
        { path: "src/b.ts", content: "b" },
      ],
      "src/a.ts",
    );
    const b = bundle(
      [
        { path: "src/b.ts", content: "b" },
        { path: "src/a.ts", content: "a" },
      ],
      "src/a.ts",
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.bundle.sha256).toBe(b.bundle.sha256);
  });

  it("changes the digest when content changes", () => {
    const a = bundle([{ path: "src/index.ts", content: "a" }]);
    const b = bundle([{ path: "src/index.ts", content: "b" }]);
    if (a.ok && b.ok) expect(a.bundle.sha256).not.toBe(b.bundle.sha256);
  });

  it("does not collide across a path/content boundary", () => {
    // Naive concatenation would make these two file sets hash identically.
    const a = hashBundle([{ path: "src/ab.ts", content: "c" }]);
    const b = hashBundle([{ path: "src/a.ts", content: "bc" }]);
    expect(a).not.toBe(b);
  });

  it("sorts files by path in the validated output", () => {
    const result = bundle(
      [
        { path: "src/z.ts", content: "z" },
        { path: "src/a.ts", content: "a" },
      ],
      "src/a.ts",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.files.map((file) => file.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("reports the total size it validated", () => {
    const result = bundle(
      [
        { path: "src/a.ts", content: "12345" },
        { path: "src/b.ts", content: "123" },
      ],
      "src/a.ts",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.totalBytes).toBe(8);
  });
});

describe("findReservedToolName", () => {
  it("finds a double-quoted, single-quoted and backticked name", () => {
    expect(findReservedToolName(`name: "submit_adr"`)).toBe("submit_adr");
    expect(findReservedToolName(`name: 'submit_adr'`)).toBe("submit_adr");
    expect(findReservedToolName("name: `submit_adr`")).toBe("submit_adr");
  });

  it("ignores a bare identifier that is not quoted", () => {
    expect(findReservedToolName("const ask_user = 1;")).toBeNull();
  });

  it("returns null for unrelated source", () => {
    expect(findReservedToolName("export default () => {};")).toBeNull();
  });
});

describe("encodeExtensionBundle", () => {
  it("encodes a versioned payload and reports its exact byte size", () => {
    const encoded = encodeExtensionBundle([
      {
        slug: "my-ext",
        entryPath: "src/index.ts",
        sha256: "a".repeat(64),
        files: [{ path: "src/index.ts", content: "x" }],
      },
    ]);
    const parsed = JSON.parse(encoded.value) as { version: number; extensions: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.extensions).toHaveLength(1);
    expect(encoded.byteSize).toBe(Buffer.byteLength(encoded.value, "utf8"));
  });

  it("encodes an empty set (nothing enabled) without throwing", () => {
    const encoded = encodeExtensionBundle([]);
    expect(JSON.parse(encoded.value)).toEqual({ version: 1, extensions: [] });
  });
});
