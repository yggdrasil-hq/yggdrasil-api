/**
 * Issue #35's readiness predicate, verified against a **real PostgreSQL**.
 *
 * **Why this exists rather than only tests.** The predicate's composition is new
 * even though each query in it is not: `evaluateModelCoverage` reads the org's
 * whole default list in one query and then resolves each *distinct* model through
 * the provider/catalog tables. The unit tests drive that with fakes, which is the
 * right shape for the branching — but a fake pool has no opinion on whether
 * Postgres accepts the statements, and this repo has shipped five bugs (#43, #56,
 * #61, #75, #76) behind a green suite built on exactly that blind spot.
 *
 * So this runs the real repositories against a real database and asserts:
 *
 * - **the predicate agrees with the schema** — an org with all five kinds set and
 *   resolvable is `ready`, and removing one kind from the *real* table makes it not
 *   ready. That second half is the ADR 018 item 6a case the old gate got wrong, and
 *   it is only meaningful against rows the database actually returned;
 * - **an unresolvable default is distinguished from an absent one** — a catalog
 *   model row deleted in the database produces `kindsThatDoNotResolve`, not
 *   `kindsWithoutDefault`;
 * - **the dedupe holds on real rows** — five kinds pointing at one model resolve
 *   without error (the failure mode of a wrong join would be an exception here).
 *
 * It creates its own org/project/provider/catalog rows and removes them, so the
 * operator's data is untouched.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i35check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i35check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-35-readiness.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` → `POSTGRES_PASSWORD`.
 * No other environment is needed: the script declares the same non-secret
 * encryption key the test suite uses (see the note at the top of the file).
 * `DROP DATABASE` is refused for agents in this sandbox, so name the database in
 * your report.
 */
import pg from "pg";

/*
 * `config.ts` asserts `SECRETS_ENCRYPTION_KEY` at *module load*, and the provider
 * repository encrypts its API key on write — so a standalone script needs a key
 * before anything that reaches config is imported. Rather than require one to be
 * passed in, this declares the same obviously-fake default `src/test-setup.ts`
 * uses, for the same reason: it is test data, not a credential, and a script whose
 * reproduction recipe needs an extra unexplained variable is a script people run
 * wrong.
 *
 * The imports below are therefore dynamic (`await import`), because a static
 * import would be evaluated before this assignment could run.
 */
process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_API_TOKEN ??= "issue-35-verify";

const { runMigrations } = await import("../../src/db/migrate.ts");
const { OrganizationRepository } = await import("../../src/organizations/repository.ts");
const { OrgProviderRepository } = await import("../../src/model-config/provider-repository.ts");
const { OrgModelRepository } = await import("../../src/model-config/model-repository.ts");
const { JobModelDefaultRepository } = await import(
  "../../src/model-config/job-default-repository.ts"
);
const { evaluateModelCoverage, evaluateOrgReadiness, evaluateEntryReadiness } = await import(
  "../../src/organizations/readiness.ts"
);
const { AGENT_JOB_KINDS } = await import("../../src/model-config/types.ts");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// --- fixtures: an org with a provider, a catalog model, and all five defaults ---
const stamp = Date.now();
const userId = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I35', $2, $1) RETURNING id`,
    [`i35_${stamp}`, stamp],
  )
).rows[0].id;
const orgId = (
  await q(
    `INSERT INTO organizations (name, slug, is_personal, status)
     VALUES ($1, $2, TRUE, 'ready') RETURNING id`,
    [`I35 org ${stamp}`, `i35-org-${stamp}`],
  )
).rows[0].id;
await q(
  `INSERT INTO organization_memberships (organization_id, user_id, role)
   VALUES ($1, $2, 'admin')`,
  [orgId, userId],
);

const orgs = new OrganizationRepository(pool);
const providers = new OrgProviderRepository(pool);
const models = new OrgModelRepository(pool);
const jobDefaults = new JobModelDefaultRepository(pool);
const deps = { organizations: orgs, providers, models, jobDefaults };

// A provider is created through the repository so its API key is encrypted the way
// the resolver expects to find it; writing the row directly would bypass the
// encryption and make `decryptApiKey` fail for a reason unrelated to the predicate.
const provider = await providers.create({
  organizationId: orgId,
  name: "I35 provider",
  providerType: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-i35-verify",
});
const catalogModel = await models.create({
  organizationId: orgId,
  providerId: provider.id,
  displayName: "I35 model",
  modelId: "i35/model",
});

// --- 1. all five kinds configured and resolvable ⇒ ready -------------------
for (const kind of AGENT_JOB_KINDS) {
  await jobDefaults.upsert(orgId, kind, catalogModel.id);
}
const orgRow = await orgs.findById(orgId);
const full = await evaluateOrgReadiness(deps, orgRow!, "admin");
check(
  "an org with all five kinds resolvable is ready",
  full.ready,
  `status=${orgRow!.status} steps=${full.steps.map((s) => `${s.id}:${s.satisfied}`).join(",")}`,
);

/*
 * --- 2. ADR 018 item 4: an in-use catalog model cannot be deleted ------------
 *
 * Asserted **here**, while all five defaults still point at it, rather than left
 * to luck: `ON DELETE RESTRICT` only refuses while something references the row,
 * so a version of this check that ran after rewiring the defaults would delete the
 * model successfully and then report the protection as missing. (That is how the
 * first version of this script failed, which is why the ordering is called out.)
 *
 * It also explains why "delete the model" is *not* how check 4 reaches an
 * unresolvable default.
 */
const restrictBlocked = await q(`DELETE FROM organization_models WHERE id = $1`, [
  catalogModel.id,
]).then(
  () => false,
  (error: { code?: string }) => error.code === "23503",
);
check(
  "an in-use catalog model is protected from deletion (ADR 018 item 4)",
  restrictBlocked,
  "expected ON DELETE RESTRICT to refuse removing a model five defaults reference",
);

// --- 3. removing one kind from the real table makes it not ready ------------
// The ADR 018 item 6a case, and the one the old `spec_grill`-only gate accepted.
await q(
  `DELETE FROM organization_job_model_defaults
    WHERE organization_id = $1 AND job_kind = 'design_grill'`,
  [orgId],
);
const partial = await evaluateModelCoverage(deps, orgId);
check(
  "removing one of five kinds is reported as missing, not silently accepted (ADR 018 item 6a)",
  partial.missing.length === 1 && partial.missing[0] === "design_grill",
  `missing=${partial.missing.join(",") || "none"}`,
);
const partialReadiness = await evaluateOrgReadiness(deps, orgRow!, "admin");
check(
  "and that org is not ready",
  !partialReadiness.ready,
  partialReadiness.steps.find((s) => s.id === "model_defaults")!.detail ?? "",
);

// --- 4. an unresolvable default is distinguished from an absent one ---------
/*
 * The reachable shape, given check 2's protection: a default pointing at a model
 * that is not in **this** org's catalog. The FK is satisfied because the row
 * exists; `resolveOrgModelConfig` looks the model up scoped to the org and finds
 * nothing. A second org supplies exactly that, and it is the same state a
 * mis-scoped or hand-edited default produces in practice.
 */
await jobDefaults.upsert(orgId, "design_grill", catalogModel.id);
const otherOrgId = (
  await q(
    `INSERT INTO organizations (name, slug, is_personal, status)
     VALUES ($1, $2, FALSE, 'ready') RETURNING id`,
    [`I35 other ${stamp}`, `i35-other-${stamp}`],
  )
).rows[0].id;
const otherProvider = await providers.create({
  organizationId: otherOrgId,
  name: "I35 other provider",
  providerType: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-i35-other",
});
const foreignModel = await models.create({
  organizationId: otherOrgId,
  providerId: otherProvider.id,
  displayName: "I35 foreign model",
  modelId: "i35/foreign",
});
for (const kind of AGENT_JOB_KINDS) {
  await q(
    `UPDATE organization_job_model_defaults SET model_id = $2
      WHERE organization_id = $1 AND job_kind = $3`,
    [orgId, foreignModel.id, kind],
  );
}
const orphaned = await evaluateModelCoverage(deps, orgId);
check(
  "a default pointing outside this org's catalog reads as unresolvable, not as unset",
  orphaned.kindsThatDoNotResolve.length === 5 && orphaned.kindsWithoutDefault.length === 0,
  `doNotResolve=${orphaned.kindsThatDoNotResolve.length} withoutDefault=${orphaned.kindsWithoutDefault.length}`,
);

// And that state blocks entry, which is the user-visible consequence.
const entry = await evaluateEntryReadiness(deps, userId);
check(
  "an org whose defaults do not resolve blocks entry",
  entry.entryAllowed === false && entry.organizations.length === 1,
  `entryAllowed=${entry.entryAllowed} orgs=${entry.organizations.length}`,
);

// --- 5. a pending cluster blocks, independently of the models ---------------
// Point the defaults back at a model this org can resolve, so the only thing wrong
// is the cluster — otherwise this check would pass for the wrong reason.
for (const kind of AGENT_JOB_KINDS) {
  await jobDefaults.upsert(orgId, kind, catalogModel.id);
}
await q(`UPDATE organizations SET status = 'pending_cluster' WHERE id = $1`, [orgId]);
const pendingOrg = await orgs.findById(orgId);
const pending = await evaluateOrgReadiness(deps, pendingOrg!, "admin");
check(
  "a pending cluster blocks readiness even when every model resolves",
  !pending.ready &&
    pending.steps.find((s) => s.id === "cluster")!.satisfied === false &&
    pending.steps.find((s) => s.id === "model_defaults")!.satisfied === true,
  `steps=${pending.steps.map((s) => `${s.id}:${s.satisfied}`).join(",")}`,
);

// --- cleanup: remove the fixtures, leaving the database as it was found -----
await q(`DELETE FROM organization_job_model_defaults WHERE organization_id IN ($1, $2)`, [
  orgId,
  otherOrgId,
]);
await q(`DELETE FROM organization_models WHERE organization_id IN ($1, $2)`, [orgId, otherOrgId]);
await q(`DELETE FROM organization_model_providers WHERE organization_id IN ($1, $2)`, [
  orgId,
  otherOrgId,
]);
await q(`DELETE FROM organization_memberships WHERE organization_id IN ($1, $2)`, [
  orgId,
  otherOrgId,
]);
await q(`DELETE FROM organizations WHERE id IN ($1, $2)`, [orgId, otherOrgId]);
await q(`DELETE FROM users WHERE id = $1`, [userId]);
console.log("\nfixtures removed; the database is as it was found.");

await pool.end();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
