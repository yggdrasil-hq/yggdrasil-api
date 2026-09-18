import crypto from "node:crypto";
import type pg from "pg";
import { extensionFileKey } from "../storage/keys.js";
import type { ObjectStorage } from "../storage/client.js";
import type { ValidatedBundle } from "./bundle.js";
import type {
  OrgExtension,
  OrgExtensionFile,
  OrgExtensionWithUploader,
} from "./types.js";

interface ExtensionRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  entry_path: string;
  source_sha256: string;
  active: boolean;
  uploaded_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ExtensionWithUploaderRow extends ExtensionRow {
  uploaded_by_username: string | null;
  uploaded_by_display_name: string | null;
  enabled_project_count: string;
}

interface FileRow {
  path: string;
  content: string | null;
  size_bytes: number;
  storage_backend: StorageBackend;
  object_key: string | null;
}

type StorageBackend = "postgres" | "object";

const EXTENSION_COLUMNS = `
    id, organization_id, slug, name, entry_path, source_sha256, active,
    uploaded_by_user_id, created_at, updated_at
`;

function mapExtension(row: ExtensionRow): OrgExtension {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    entryPath: row.entry_path,
    sourceSha256: row.source_sha256,
    active: row.active,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExtensionWithUploader(row: ExtensionWithUploaderRow): OrgExtensionWithUploader {
  return {
    ...mapExtension(row),
    uploadedByUsername: row.uploaded_by_username,
    uploadedByDisplayName: row.uploaded_by_display_name,
    // COUNT() comes back as text from Postgres; not coercing it would leak a
    // number-shaped string into the public JSON.
    enabledProjectCount: Number(row.enabled_project_count),
  };
}

export interface CreateExtensionInput {
  organizationId: string;
  slug: string;
  name: string;
  uploadedByUserId: string;
  bundle: ValidatedBundle;
}

/**
 * ADR 025 storage, on either backend (issue #30). The upload is one transaction:
 * replacing an extension deletes its old files and inserts the new set, so a
 * reader can never see a half-replaced file list (which would be served as a
 * bundle whose contents do not match its stored digest).
 *
 * **The transaction is why this repository migrates differently from the two
 * artifact ones.** A recording's bytes are written before its row, and the
 * object is cleaned up if the row fails — safe because a recording has no other
 * rows to disagree with. An extension's files are many rows in *one*
 * transaction, so objects written for a transaction that then rolls back would
 * be orphaned in bulk, and objects written *inside* the transaction would hold
 * a database connection open across N network calls.
 *
 * The order used instead is: write every object first, then run the transaction
 * that replaces the rows. A rollback therefore leaves a complete set of
 * unreferenced objects rather than a half-written file list, and the failure is
 * one `deleteObject` per file away from clean — reported, not silent. The
 * property that matters most is kept: a reader resolving the extension through
 * its rows can never see a file whose bytes are missing, because the rows that
 * name the objects are the last thing to appear.
 *
 * `listFiles` is where the delivery contract is claimed to be unchanged (ADR
 * 025: "the delivery contract would not change on a move to object storage"),
 * so that claim is worth checking rather than repeating — and it holds, because
 * the method still returns `{path, content, sizeBytes}` and fetches whatever it
 * needs to fill `content`. The cost the claim hides is that it is no longer a
 * single query: delivering an active extension now issues one object read per
 * file, sequentially. That is a real latency change on the job-pod delivery
 * path, and it is recorded here rather than discovered later.
 */
export class OrgExtensionRepository {
  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage | null = null,
  ) {}

  /**
   * Create, or replace the files of, the extension with this (org, slug).
   * Replacing keeps the row id stable so a project's opt-in and the audit
   * trail's target ids stay meaningful across revisions.
   */
  async createOrReplace(input: CreateExtensionInput): Promise<OrgExtension> {
    /**
     * The extension's id is resolved *before* anything is written, which is what
     * lets every object be written outside the transaction. A replacement keeps
     * its id (`ON CONFLICT` keeps the row, so a project's opt-in and the audit
     * trail's target ids stay meaningful); a first upload has no id yet, so one
     * is generated here and passed to the insert explicitly rather than being
     * left to the column default.
     *
     * That is the whole reason this is a `randomUUID()` and not letting the
     * database choose: the object keys must be known before the rows that
     * reference them exist, and generating the id is the cheapest way to know
     * them without holding a database connection across N network calls.
     */
    const existingId = await this.findIdBySlug(input.organizationId, input.slug);
    const extensionId = existingId ?? crypto.randomUUID();

    if (this.storage) {
      await this.putBundleObjects(extensionId, input);
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO org_extensions
           (id, organization_id, slug, name, entry_path, source_sha256, uploaded_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, slug) DO UPDATE SET
           name = EXCLUDED.name,
           entry_path = EXCLUDED.entry_path,
           source_sha256 = EXCLUDED.source_sha256,
           -- A replacement is itself an act of trust: re-activate, so a
           -- kill-switched extension comes back only when someone
           -- deliberately uploads a new revision of it.
           active = TRUE,
           uploaded_by_user_id = EXCLUDED.uploaded_by_user_id,
           updated_at = NOW()
         RETURNING id`,
        [
          extensionId,
          input.organizationId,
          input.slug,
          input.name,
          input.bundle.entryPath,
          input.bundle.sha256,
          input.uploadedByUserId,
        ],
      );
      const savedId = rows[0]!.id;

      /*
       * A concurrent upload of the same new slug can win the insert, in which
       * case the row we are now bound to has an id we did not generate and the
       * objects are sitting under the wrong prefix. This is the one path that
       * touches storage inside the transaction, and it is worth the exception:
       * it is rare, it is bounded by the bundle's own file count (ADR 025 caps
       * it), and the alternative — committing rows that reference objects which
       * do not exist — is exactly the broken state the ordering exists to
       * prevent. Rows are written after the objects in every path.
       */
      if (this.storage && savedId !== extensionId) {
        await this.putBundleObjects(savedId, input);
      }

      await client.query("DELETE FROM org_extension_files WHERE extension_id = $1", [savedId]);

      for (const file of input.bundle.files) {
        await client.query(
          `INSERT INTO org_extension_files
             (extension_id, path, content, size_bytes, storage_backend, object_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            savedId,
            file.path,
            this.storage ? null : file.content,
            file.sizeBytes,
            this.storage ? "object" : "postgres",
            this.storage
              ? extensionFileKey({
                  organizationId: input.organizationId,
                  extensionId: savedId,
                  path: file.path,
                })
              : null,
          ],
        );
      }

      const saved = await client.query<ExtensionRow>(
        `SELECT ${EXTENSION_COLUMNS} FROM org_extensions WHERE id = $1`,
        [savedId],
      );

      await client.query("COMMIT");
      return mapExtension(saved.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Writes every file of a bundle as an object.
   *
   * Called outside the transaction in the ordinary path, so a rollback leaves a
   * complete but unreferenced set of objects rather than a partially written one
   * — recoverable by deleting the prefix, and never visible to a reader, because
   * no row names them yet.
   */
  private async putBundleObjects(
    extensionId: string,
    input: CreateExtensionInput,
  ): Promise<void> {
    for (const file of input.bundle.files) {
      await this.storage!.putObject({
        key: extensionFileKey({
          organizationId: input.organizationId,
          extensionId,
          path: file.path,
        }),
        // The column being replaced is TEXT, so the bytes are the file's UTF-8
        // encoding; `listFiles` decodes the same way, which is what makes the
        // round trip byte-identical to the pre-change behaviour.
        body: Buffer.from(file.content, "utf8"),
        contentType: extensionContentType(file.path),
      });
    }
  }

  async listForOrganization(organizationId: string): Promise<OrgExtensionWithUploader[]> {
    const { rows } = await this.db.query<ExtensionWithUploaderRow>(
      `SELECT e.id, e.organization_id, e.slug, e.name, e.entry_path, e.source_sha256,
              e.active, e.uploaded_by_user_id, e.created_at, e.updated_at,
              u.username AS uploaded_by_username,
              u.display_name AS uploaded_by_display_name,
              (
                SELECT COUNT(*)::text FROM projects p
                 WHERE p.organization_id = e.organization_id
                   AND p.uploaded_extensions_enabled
              ) AS enabled_project_count
         FROM org_extensions e
         LEFT JOIN users u ON u.id = e.uploaded_by_user_id
        WHERE e.organization_id = $1
        ORDER BY e.name ASC`,
      [organizationId],
    );
    return rows.map(mapExtensionWithUploader);
  }

  async findById(extensionId: string): Promise<OrgExtension | null> {
    const { rows } = await this.db.query<ExtensionRow>(
      `SELECT ${EXTENSION_COLUMNS} FROM org_extensions WHERE id = $1`,
      [extensionId],
    );
    return rows[0] ? mapExtension(rows[0]) : null;
  }

  async listFiles(extensionId: string): Promise<OrgExtensionFile[]> {
    const { rows } = await this.db.query<FileRow>(
      `SELECT path, content, size_bytes, storage_backend, object_key
         FROM org_extension_files
        WHERE extension_id = $1 ORDER BY path ASC`,
      [extensionId],
    );

    const files: OrgExtensionFile[] = [];
    for (const row of rows) {
      if (row.storage_backend === "postgres" || row.object_key === null) {
        // A row written before object storage was configured. `content` is
        // NOT NULL for these, so the null case is unreachable — but asserted
        // rather than assumed, because returning it would hand the delivery
        // path a file whose bytes silently became the string "null".
        files.push({
          path: row.path,
          content: row.content ?? "",
          sizeBytes: row.size_bytes,
        });
        continue;
      }

      const bytes = await this.storage!.getObject(row.object_key);
      if (bytes === null) {
        // The digest check downstream is what protects the container from a
        // bundle that does not match, so an absent object must surface as a
        // failure rather than as an empty file that quietly changes the digest.
        throw new Error(
          `extension file ${row.path} is recorded at ${row.object_key}, but that object does not exist`,
        );
      }
      files.push({
        path: row.path,
        content: bytes.toString("utf8"),
        sizeBytes: row.size_bytes,
      });
    }
    return files;
  }

  /**
   * The id of an existing slug, or null. Used to derive object keys before the
   * transaction that upserts the row, since a replacement keeps its id and
   * therefore its keys.
   */
  private async findIdBySlug(
    organizationId: string,
    slug: string,
    client?: pg.PoolClient,
  ): Promise<string | null> {
    const queryable = client ?? this.db;
    const { rows } = await queryable.query<{ id: string }>(
      `SELECT id FROM org_extensions WHERE organization_id = $1 AND slug = $2`,
      [organizationId, slug],
    );
    return rows[0]?.id ?? null;
  }

  /** Which projects in the org have loaded extensions turned on at all. */
  async listEnabledProjects(
    organizationId: string,
  ): Promise<Array<{ id: string; name: string; slug: string }>> {
    const { rows } = await this.db.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM projects
        WHERE organization_id = $1 AND uploaded_extensions_enabled
        ORDER BY name ASC`,
      [organizationId],
    );
    return rows;
  }

  async countForOrganization(organizationId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM org_extensions WHERE organization_id = $1`,
      [organizationId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async setActive(extensionId: string, active: boolean): Promise<void> {
    await this.db.query(
      `UPDATE org_extensions SET active = $2, updated_at = NOW() WHERE id = $1`,
      [extensionId, active],
    );
  }

  async remove(extensionId: string): Promise<void> {
    // Files cascade (migration 040), so one delete removes the artifact whole.
    await this.db.query(`DELETE FROM org_extensions WHERE id = $1`, [extensionId]);
  }

  /**
   * Every active extension of an org with its files, for delivery to a job
   * pod. Only called for a project that has opted in — the opt-in check lives
   * in the route so this method stays a plain read.
   */
  async listActiveWithFiles(organizationId: string): Promise<
    Array<{ extension: OrgExtension; files: OrgExtensionFile[] }>
  > {
    const { rows } = await this.db.query<ExtensionRow>(
      `SELECT ${EXTENSION_COLUMNS} FROM org_extensions
        WHERE organization_id = $1 AND active
        ORDER BY slug ASC`,
      [organizationId],
    );

    const result: Array<{ extension: OrgExtension; files: OrgExtensionFile[] }> = [];
    for (const row of rows) {
      const extension = mapExtension(row);
      result.push({ extension, files: await this.listFiles(extension.id) });
    }
    return result;
  }
}

/**
 * The content type for a stored bundle file.
 *
 * Almost every file in an extension is source, so this is `utf8` text for
 * everything except the handful of binary-ish assets a bundle may carry. The
 * value is stored for an operator browsing the bucket and is never used to
 * decide how the API reads the bytes back — `listFiles` always decodes as UTF-8,
 * exactly as the `content TEXT` column did, so the round trip is byte-identical
 * to before this change.
 */
function extensionContentType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".png")) return "image/png";
  return "text/plain; charset=utf-8";
}
