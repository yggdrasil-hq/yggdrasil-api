/**
 * ADR 025: an uploaded Pi extension.
 *
 * `sourceSha256` is the API's digest over the stored file set. It exists so
 * "which revision of this extension was loaded into that run" is answerable
 * after the fact: the job container logs the same digest, and the API
 * recomputes and compares it at delivery time.
 */
export interface OrgExtension {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  entryPath: string;
  sourceSha256: string;
  active: boolean;
  uploadedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The uploader's display name, joined in for the admin list. */
export interface OrgExtensionWithUploader extends OrgExtension {
  uploadedByUsername: string | null;
  uploadedByDisplayName: string | null;
  /** How many projects in this org have opted in to loaded extensions. */
  enabledProjectCount: number;
}

export interface OrgExtensionFile {
  path: string;
  content: string;
  sizeBytes: number;
}

export interface PublicOrgExtension {
  id: string;
  slug: string;
  name: string;
  entryPath: string;
  sourceSha256: string;
  active: boolean;
  uploadedBy: { username: string | null; displayName: string | null } | null;
  enabledProjectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicOrgExtensionDetail extends PublicOrgExtension {
  files: Array<{ path: string; content: string; sizeBytes: number }>;
  /** Projects currently loading this extension (ADR 025 item 8). */
  enabledProjects: Array<{ id: string; name: string; slug: string }>;
}

export function toPublicOrgExtension(extension: OrgExtensionWithUploader): PublicOrgExtension {
  return {
    id: extension.id,
    slug: extension.slug,
    name: extension.name,
    entryPath: extension.entryPath,
    sourceSha256: extension.sourceSha256,
    active: extension.active,
    // Never a raw user id: the list is read by humans, and an id would send
    // the client on a second lookup just to render a name.
    uploadedBy: extension.uploadedByUserId
      ? {
          username: extension.uploadedByUsername,
          displayName: extension.uploadedByDisplayName,
        }
      : null,
    enabledProjectCount: extension.enabledProjectCount,
    createdAt: extension.createdAt.toISOString(),
    updatedAt: extension.updatedAt.toISOString(),
  };
}
