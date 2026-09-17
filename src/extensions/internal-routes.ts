import { Router } from "express";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import type { ProjectRepository } from "../projects/repository.js";
import { AGENT_JOB_KINDS, type AgentJobKind } from "../model-config/types.js";
import { EXTENSION_LIMITS, encodeExtensionBundle, hashBundle } from "./bundle.js";
import type { OrgExtensionRepository } from "./repository.js";

/**
 * The env var an uploaded bundle travels in. Not a file service and not a
 * volume — the Orchestrator's only file-delivery path into a job pod is env
 * vars, which is how ADR_MARKDOWN and the test-spec markdown already reach the
 * container (ADR 008 / ADR 015), and how the GitHub token and model config
 * arrive (ADR 004). A bundle is small and bounded by design (see
 * bundle.ts's EXTENSION_LIMITS), so it fits the path that already exists.
 *
 * The container's entrypoint writes these files to disk before Pi starts, and
 * re-validates every path itself rather than trusting this response.
 */
export const EXTENSION_BUNDLE_ENV_KEY = "PI_EXTENSIONS_BUNDLE";

function isAgentJobKind(value: unknown): value is AgentJobKind {
  return typeof value === "string" && (AGENT_JOB_KINDS as readonly string[]).includes(value);
}

/**
 * ADR 025 item 8: the Orchestrator asks for a project's extension bundle at
 * dispatch time, exactly as it asks for model config. Returns an env fragment
 * so the caller merges one map and needs no encoding logic of its own.
 *
 * Two gates, both required:
 *   1. the project opted in (`uploaded_extensions_enabled`), and
 *   2. the job kind actually runs Pi.
 *
 * Non-agent kinds (`deploy`, `script_test_run`, `rollback`) get an empty
 * fragment structurally, not by policy — they never launch Pi, so there is
 * nothing for an extension to attach to. `spec_grill` is included even though
 * it is the weakest beneficiary: it is still a Pi run, and excluding it would
 * make the feature's availability depend on which job kind a user happened to
 * be looking at.
 *
 * An extension is *never* returned for a project that has not opted in, even
 * if the org has active extensions — the opt-in is the whole control.
 */
export function createExtensionsInternalRouter(deps: {
  projects: ProjectRepository;
  extensions: OrgExtensionRepository;
}): Router {
  const router = Router();

  router.get("/projects/:projectId/extensions", requireInternalApiToken, async (req, res) => {
    const projectId = routeParam(req.params.projectId);
    if (!isUuid(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const project = await deps.projects.findById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const jobKind = req.query.jobKind;
    if (!project.uploadedExtensionsEnabled || !isAgentJobKind(jobKind)) {
      res.json({ env: {} });
      return;
    }

    const active = await deps.extensions.listActiveWithFiles(project.organizationId);
    if (active.length === 0) {
      res.json({ env: {} });
      return;
    }

    const encoded = encodeExtensionBundle(
      active.map(({ extension, files }) => ({
        slug: extension.slug,
        entryPath: extension.entryPath,
        sha256: extension.sourceSha256,
        files: files.map((file) => ({ path: file.path, content: file.content })),
      })),
    );

    // Unreachable while EXTENSION_LIMITS' arithmetic holds (see bundle.ts).
    // Checked because the alternative failure is a job that never starts with
    // no explanation: a pod spec over Kubernetes' object-size limit is
    // rejected at admission, which surfaces as "the pod never came up".
    if (encoded.byteSize > EXTENSION_LIMITS.maxEncodedBytes) {
      console.error(
        `extensions: bundle for project ${projectId} is ${encoded.byteSize} bytes, over the ${EXTENSION_LIMITS.maxEncodedBytes}-byte delivery limit`,
      );
      res.status(500).json({ error: "Extension bundle exceeds the delivery limit" });
      return;
    }

    // A digest mismatch means the stored files no longer match the revision
    // the extension claims to be, so the run would be unreproducible and the
    // sha256 it logs would be wrong. Refusing is louder than serving it.
    for (const { extension, files } of active) {
      const actual = hashBundle(files.map((file) => ({ path: file.path, content: file.content })));
      if (actual !== extension.sourceSha256) {
        console.error(
          `extensions: stored revision of ${extension.slug} (${extension.id}) hashes to ${actual}, not the recorded ${extension.sourceSha256}`,
        );
        res.status(500).json({ error: "Stored extension revision is inconsistent" });
        return;
      }
    }

    res.json({ env: { [EXTENSION_BUNDLE_ENV_KEY]: encoded.value } });
  });

  return router;
}
