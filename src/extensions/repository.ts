import type pg from "pg";
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
  content: string;
  size_bytes: number;
}

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
 * ADR 025 storage. The upload is one transaction: replacing an extension
 * deletes its old files and inserts the new set, so a reader can never see a
 * half-replaced file list (which would be served as a bundle whose contents do
 * not match its stored digest).
 */
export class OrgExtensionRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Create, or replace the files of, the extension with this (org, slug).
   * Replacing keeps the row id stable so a project's opt-in and the audit
   * trail's target ids stay meaningful across revisions.
   */
  async createOrReplace(input: CreateExtensionInput): Promise<OrgExtension> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO org_extensions
           (organization_id, slug, name, entry_path, source_sha256, uploaded_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
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
          input.organizationId,
          input.slug,
          input.name,
          input.bundle.entryPath,
          input.bundle.sha256,
          input.uploadedByUserId,
        ],
      );
      const extensionId = rows[0]!.id;

      await client.query("DELETE FROM org_extension_files WHERE extension_id = $1", [extensionId]);

      for (const file of input.bundle.files) {
        await client.query(
          `INSERT INTO org_extension_files (extension_id, path, content, size_bytes)
           VALUES ($1, $2, $3, $4)`,
          [extensionId, file.path, file.content, file.sizeBytes],
        );
      }

      const saved = await client.query<ExtensionRow>(
        `SELECT ${EXTENSION_COLUMNS} FROM org_extensions WHERE id = $1`,
        [extensionId],
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
      `SELECT path, content, size_bytes FROM org_extension_files
        WHERE extension_id = $1 ORDER BY path ASC`,
      [extensionId],
    );
    return rows.map((row) => ({
      path: row.path,
      content: row.content,
      sizeBytes: row.size_bytes,
    }));
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
