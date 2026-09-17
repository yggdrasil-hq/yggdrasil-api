import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createExtensionsInternalRouter } from "./internal-routes.js";
import { DEFAULT_ENTRY_PATH, hashBundle } from "./bundle.js";
import type { Project } from "../projects/types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const INTERNAL_TOKEN = "test-internal-api-token";

const GRANTED_PROJECT = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  name: "Acme web",
  slug: "acme-web",
  description: "",
  status: "ready",
  settings: {},
  installationId: null,
  githubAccessWarning: false,
  modelConfigWarning: false,
  agenticReviewEnabled: true,
  uploadedExtensionsEnabled: true,
  hasDesignSurface: false,
  repositories: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Project;

const SOURCE = "export default () => {};";
const DIGEST = hashBundle([{ path: DEFAULT_ENTRY_PATH, content: SOURCE }]);

function extensionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ext_1",
    organizationId: ORG_ID,
    slug: "my-ext",
    name: "My extension",
    entryPath: DEFAULT_ENTRY_PATH,
    sourceSha256: DIGEST,
    active: true,
    uploadedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildApp(
  opts: {
    project?: Project | null;
    active?: unknown[];
  } = {},
) {
  const app = express();
  app.use(express.json());

  const projects = {
    findById: vi.fn(async () => (opts.project === undefined ? GRANTED_PROJECT : opts.project)),
  };
  const extensions = {
    listActiveWithFiles: vi.fn(async () =>
      opts.active === undefined
        ? [
            {
              extension: extensionRow(),
              files: [{ path: DEFAULT_ENTRY_PATH, content: SOURCE, sizeBytes: SOURCE.length }],
            },
          ]
        : opts.active,
    ),
  };

  app.use("/internal", createExtensionsInternalRouter({ projects, extensions } as never));
  return { app, projects, extensions };
}

function get(app: express.Express, query = "jobKind=feature_build") {
  return request(app)
    .get(`/internal/projects/${PROJECT_ID}/extensions?${query}`)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`);
}

describe("GET /internal/projects/:projectId/extensions", () => {
  it("rejects a request with no bearer token", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/internal/projects/${PROJECT_ID}/extensions`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/extensions`)
      .set("Authorization", "Bearer not-the-token");
    expect(res.status).toBe(401);
  });

  it("404s an unknown project", async () => {
    const { app } = buildApp({ project: null });
    const res = await get(app);
    expect(res.status).toBe(404);
  });

  // The opt-in is the entire control, so its negative case is the important one.
  it("returns nothing when the project has not opted in, and never reads the org's extensions", async () => {
    const { app, extensions } = buildApp({
      project: { ...GRANTED_PROJECT, uploadedExtensionsEnabled: false } as Project,
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ env: {} });
    expect(extensions.listActiveWithFiles).not.toHaveBeenCalled();
  });

  it("returns nothing for a job kind that never runs Pi, even when opted in", async () => {
    for (const kind of ["deploy", "script_test_run", "rollback", "not-a-kind"]) {
      const { app, extensions } = buildApp();
      const res = await get(app, `jobKind=${kind}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ env: {} });
      expect(extensions.listActiveWithFiles).not.toHaveBeenCalled();
    }
  });

  it("returns nothing when the org has no active extensions", async () => {
    const { app } = buildApp({ active: [] });
    const res = await get(app);
    expect(res.body).toEqual({ env: {} });
  });

  it("delivers the bundle as an env fragment for an opted-in project", async () => {
    const { app } = buildApp();
    const res = await get(app);
    expect(res.status).toBe(200);
    const value = res.body.env.PI_EXTENSIONS_BUNDLE as string;
    expect(typeof value).toBe("string");

    const parsed = JSON.parse(value) as {
      version: number;
      extensions: Array<{ slug: string; entryPath: string; sha256: string; files: unknown[] }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.extensions).toHaveLength(1);
    expect(parsed.extensions[0]!.slug).toBe("my-ext");
    expect(parsed.extensions[0]!.entryPath).toBe(DEFAULT_ENTRY_PATH);
    // The digest travels so the container can log which revision ran.
    expect(parsed.extensions[0]!.sha256).toBe(DIGEST);
    expect(parsed.extensions[0]!.files).toHaveLength(1);
  });

  it("serves every agent job kind when opted in", async () => {
    for (const kind of ["spec_grill", "feature_build", "test_run", "agentic_review", "design_grill"]) {
      const { app } = buildApp();
      const res = await get(app, `jobKind=${kind}`);
      expect(res.status).toBe(200);
      expect(res.body.env.PI_EXTENSIONS_BUNDLE).toBeTruthy();
    }
  });

  it("refuses to serve a bundle whose stored files no longer match its digest", async () => {
    // A silently-wrong digest would make a run unreproducible and its logged
    // revision a lie, so this is a loud failure rather than a served bundle.
    const { app } = buildApp({
      active: [
        {
          extension: extensionRow({ sourceSha256: "b".repeat(64) }),
          files: [{ path: DEFAULT_ENTRY_PATH, content: SOURCE, sizeBytes: SOURCE.length }],
        },
      ],
    });
    const res = await get(app);
    expect(res.status).toBe(500);
    expect(res.body.env).toBeUndefined();
  });
});
