import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOrgExtensionsRouter } from "./routes.js";
import { DEFAULT_ENTRY_PATH, EXTENSION_LIMITS } from "./bundle.js";
import type { OrgExtension } from "./types.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "99999999-9999-4999-8999-999999999999";
const EXTENSION_ID = "44444444-4444-4444-8444-444444444444";

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function makeExtension(overrides: Partial<OrgExtension> = {}): OrgExtension {
  return {
    id: EXTENSION_ID,
    organizationId: ORG_ID,
    slug: "my-ext",
    name: "My extension",
    entryPath: DEFAULT_ENTRY_PATH,
    sourceSha256: "a".repeat(64),
    active: true,
    uploadedByUserId: USER_ID,
    createdAt: new Date("2026-09-18T00:00:00.000Z"),
    updatedAt: new Date("2026-09-18T00:00:00.000Z"),
    ...overrides,
  };
}

const VALID_SOURCE = "export default () => {};";

function uploadBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "My extension",
    files: [{ path: DEFAULT_ENTRY_PATH, content: VALID_SOURCE }],
    acknowledgedRisk: true,
    ...overrides,
  };
}

function buildApp(
  opts: {
    role?: string | null;
    existing?: unknown[];
    extension?: OrgExtension | null;
    enabledProjects?: Array<{ id: string; name: string; slug: string }>;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const users = { findById: vi.fn(async () => ({ id: USER_ID } as User)) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const role = opts.role === undefined ? "admin" : opts.role;
  const organizations = { roleForUser: vi.fn(async () => role) };

  const existing = opts.existing ?? [];
  const extension = opts.extension === undefined ? makeExtension() : opts.extension;
  const extensions = {
    listForOrganization: vi.fn(async () => existing),
    findById: vi.fn(async () => extension),
    listFiles: vi.fn(async () => [
      { path: DEFAULT_ENTRY_PATH, content: VALID_SOURCE, sizeBytes: VALID_SOURCE.length },
    ]),
    listEnabledProjects: vi.fn(async () => opts.enabledProjects ?? []),
    createOrReplace: vi.fn(async (input: { slug: string; bundle: { sha256: string; entryPath: string } }) =>
      // Faithful to the real repository, which returns the row it just wrote
      // -- including the digest it stored, so this equals the validated one.
      makeExtension({
        slug: input.slug,
        sourceSha256: input.bundle.sha256,
        entryPath: input.bundle.entryPath,
      }),
    ),
    setActive: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const audit = {
    record: vi.fn(async (_res: unknown, _input: { action: string }) => undefined),
  };

  app.use(
    "/organizations",
    createOrgExtensionsRouter({
      users,
      sessions,
      organizations,
      extensions,
      audit,
    } as never),
  );

  return { app, extensions, audit, organizations };
}

function authed(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    post: (url: string) => request(app).post(url).set("Cookie", SESSION_COOKIE),
    patch: (url: string) => request(app).patch(url).set("Cookie", SESSION_COOKIE),
    delete: (url: string) => request(app).delete(url).set("Cookie", SESSION_COOKIE),
  };
}

const BASE = `/organizations/${ORG_ID}/extensions`;

describe("org extension authorization", () => {
  it("401s an unauthenticated caller", async () => {
    const { app } = buildApp();
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it("404s a non-member rather than revealing the org exists", async () => {
    const { app } = buildApp({ role: null });
    const res = await authed(app).get(BASE);
    expect(res.status).toBe(404);
  });

  it("403s a member who is not an admin, for every method", async () => {
    const { app } = buildApp({ role: "developer" });
    const client = authed(app);
    expect((await client.get(BASE)).status).toBe(403);
    expect((await client.post(BASE).send(uploadBody())).status).toBe(403);
    expect((await client.patch(`${BASE}/${EXTENSION_ID}`).send({ active: false })).status).toBe(403);
    expect((await client.delete(`${BASE}/${EXTENSION_ID}`)).status).toBe(403);
  });

  it("404s an unknown organization id shape", async () => {
    const { app } = buildApp();
    const res = await authed(app).get("/organizations/not-a-uuid/extensions");
    expect(res.status).toBe(404);
  });
});

describe("GET /organizations/:organizationId/extensions", () => {
  it("lists extensions with uploader and opt-in count, and no file contents", async () => {
    const { app } = buildApp({
      existing: [
        {
          ...makeExtension(),
          uploadedByUsername: "sarat",
          uploadedByDisplayName: "Sarat",
          enabledProjectCount: 2,
        },
      ],
    });
    const res = await authed(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.extensions).toHaveLength(1);
    const [extension] = res.body.extensions;
    expect(extension.slug).toBe("my-ext");
    expect(extension.uploadedBy).toEqual({ username: "sarat", displayName: "Sarat" });
    expect(extension.enabledProjectCount).toBe(2);
    expect(extension.files).toBeUndefined();
  });
});

describe("GET /organizations/:organizationId/extensions/:extensionId", () => {
  it("serves the source so a second admin can read what is installed", async () => {
    const { app } = buildApp();
    const res = await authed(app).get(`${BASE}/${EXTENSION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.extension.files).toHaveLength(1);
    expect(res.body.extension.files[0].content).toBe(VALID_SOURCE);
  });

  it("404s an extension belonging to another organization", async () => {
    const { app } = buildApp({ extension: makeExtension({ organizationId: OTHER_ORG_ID }) });
    const res = await authed(app).get(`${BASE}/${EXTENSION_ID}`);
    expect(res.status).toBe(404);
  });

  it("404s an unknown extension", async () => {
    const { app } = buildApp({ extension: null });
    const res = await authed(app).get(`${BASE}/${EXTENSION_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /organizations/:organizationId/extensions", () => {
  it("stores a valid bundle and records the upload with digest metadata", async () => {
    const { app, extensions, audit } = buildApp();
    const res = await authed(app).post(BASE).send(uploadBody());
    expect(res.status).toBe(201);

    expect(extensions.createOrReplace).toHaveBeenCalledTimes(1);
    const input = extensions.createOrReplace.mock.calls[0]![0] as {
      organizationId: string;
      slug: string;
      uploadedByUserId: string;
      bundle: { entryPath: string; sha256: string; files: unknown[] };
    };
    expect(input.organizationId).toBe(ORG_ID);
    expect(input.slug).toBe("my-extension");
    expect(input.uploadedByUserId).toBe(USER_ID);
    expect(input.bundle.entryPath).toBe(DEFAULT_ENTRY_PATH);
    expect(input.bundle.sha256).toMatch(/^[a-f0-9]{64}$/);

    const recorded = audit.record.mock.calls[0]![1] as { action: string; metadata: Record<string, unknown> };
    expect(recorded.action).toBe("extension.uploaded");
    expect(recorded.metadata.slug).toBe("my-extension");
    expect(recorded.metadata.sourceSha256).toBe(input.bundle.sha256);
    // The trail is broadly readable and kept forever, so it must never carry
    // the uploaded source itself.
    expect(JSON.stringify(recorded.metadata)).not.toContain(VALID_SOURCE);
  });

  it("requires an explicit trust acknowledgement", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app).post(BASE).send(uploadBody({ acknowledgedRisk: undefined }));
    expect(res.status).toBe(400);
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects a false acknowledgement", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app).post(BASE).send(uploadBody({ acknowledgedRisk: false }));
    expect(res.status).toBe(400);
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects a traversal path without storing anything", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app)
      .post(BASE)
      .send(uploadBody({ files: [{ path: "../../../root/.pi/x.ts", content: "x" }] }));
    expect(res.status).toBe(400);
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects absolute paths, backslashes and disallowed extensions", async () => {
    for (const path of ["/etc/passwd", "src\\index.ts", "run.sh"]) {
      const { app, extensions } = buildApp();
      const res = await authed(app)
        .post(BASE)
        .send(uploadBody({ files: [{ path, content: "x" }] }));
      expect(res.status).toBe(400);
      expect(extensions.createOrReplace).not.toHaveBeenCalled();
    }
  });

  it("rejects a bundle that redefines a contract tool", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app)
      .post(BASE)
      .send(
        uploadBody({
          files: [{ path: DEFAULT_ENTRY_PATH, content: 'registerTool({ name: "submit_adr" });' }],
        }),
      );
    expect(res.status).toBe(400);
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects a package.json that declares dependencies", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app)
      .post(BASE)
      .send(
        uploadBody({
          files: [
            { path: DEFAULT_ENTRY_PATH, content: VALID_SOURCE },
            { path: "package.json", content: JSON.stringify({ dependencies: { lodash: "^4" } }) },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects an entry path that is not in the bundle", async () => {
    const { app } = buildApp();
    const res = await authed(app).post(BASE).send(uploadBody({ entryPath: "src/missing.ts" }));
    expect(res.status).toBe(400);
  });

  it("rejects a slug that is not lowercase-dashed", async () => {
    const { app } = buildApp();
    const res = await authed(app).post(BASE).send(uploadBody({ slug: "Not A Slug" }));
    expect(res.status).toBe(400);
  });

  it("refuses a new extension once the org is at the cap", async () => {
    const existing = Array.from({ length: EXTENSION_LIMITS.maxPerOrganization }, (_, index) => ({
      ...makeExtension({ id: `ext_${index}`, slug: `existing-${index}` }),
      uploadedByUsername: null,
      uploadedByDisplayName: null,
      enabledProjectCount: 0,
    }));
    const { app, extensions } = buildApp({ existing });
    const res = await authed(app).post(BASE).send(uploadBody({ name: "Brand new", slug: "brand-new" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at most");
    expect(extensions.createOrReplace).not.toHaveBeenCalled();
  });

  it("allows replacing an existing extension even at the cap", async () => {
    // Otherwise reaching the cap would make every stored extension frozen.
    const existing = Array.from({ length: EXTENSION_LIMITS.maxPerOrganization }, (_, index) => ({
      ...makeExtension({ id: `ext_${index}`, slug: `existing-${index}` }),
      uploadedByUsername: null,
      uploadedByDisplayName: null,
      enabledProjectCount: 0,
    }));
    const { app, extensions } = buildApp({ existing });
    const res = await authed(app).post(BASE).send(uploadBody({ name: "Existing 0", slug: "existing-0" }));
    expect(res.status).toBe(201);
    expect(extensions.createOrReplace).toHaveBeenCalledTimes(1);
  });

  it("derives a slug from the name when none is given", async () => {
    const { app, extensions } = buildApp();
    await authed(app).post(BASE).send(uploadBody({ name: "My Fancy Extension", slug: undefined }));
    const input = extensions.createOrReplace.mock.calls[0]![0] as { slug: string };
    expect(input.slug).toBe("my-fancy-extension");
  });
});

describe("PATCH /organizations/:organizationId/extensions/:extensionId", () => {
  it("records a kill-switch toggle", async () => {
    const { app, extensions, audit } = buildApp();
    const res = await authed(app).patch(`${BASE}/${EXTENSION_ID}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(extensions.setActive).toHaveBeenCalledWith(EXTENSION_ID, false);
    const recorded = audit.record.mock.calls[0]![1] as { action: string; metadata: Record<string, unknown> };
    expect(recorded.action).toBe("extension.activation_changed");
    expect(recorded.metadata.active).toBe(false);
  });

  it("rejects a non-boolean active value", async () => {
    const { app, extensions } = buildApp();
    const res = await authed(app).patch(`${BASE}/${EXTENSION_ID}`).send({ active: "yes" });
    expect(res.status).toBe(400);
    expect(extensions.setActive).not.toHaveBeenCalled();
  });
});

describe("DELETE /organizations/:organizationId/extensions/:extensionId", () => {
  it("removes the extension and records it", async () => {
    const { app, extensions, audit } = buildApp();
    const res = await authed(app).delete(`${BASE}/${EXTENSION_ID}`);
    expect(res.status).toBe(204);
    expect(extensions.remove).toHaveBeenCalledWith(EXTENSION_ID);
    const recorded = audit.record.mock.calls[0]![1] as { action: string };
    expect(recorded.action).toBe("extension.deleted");
  });

  it("404s an extension from another organization without deleting it", async () => {
    const { app, extensions } = buildApp({
      extension: makeExtension({ organizationId: OTHER_ORG_ID }),
    });
    const res = await authed(app).delete(`${BASE}/${EXTENSION_ID}`);
    expect(res.status).toBe(404);
    expect(extensions.remove).not.toHaveBeenCalled();
  });
});
