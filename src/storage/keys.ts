/**
 * Issue #30: where an artifact lands in the bucket.
 *
 * Keys are derived from ids the database already holds rather than being
 * random, for three reasons:
 *
 * 1. **A row and its object can be reconciled without a lookup table.** The key
 *    is a pure function of the row, so a backfill, a re-upload and a purge all
 *    compute the same string from the same inputs — there is no second source
 *    of truth to drift, and no window where the row exists and the key does not.
 * 2. **Replacing an artifact overwrites in place.** Every one of these features
 *    upserts (a retried upload replaces rather than duplicates — see each
 *    repository's comment on `ON CONFLICT`), which is only true of the object if
 *    the key is stable across retries. A random key would leak an orphan per
 *    retry.
 * 3. **The bucket is browsable.** An operator debugging "where did that
 *    recording go" gets a directory tree that names projects and jobs, which is
 *    the difference between object storage being inspectable and being opaque.
 *
 * The trade-off is that the key is not secret: it encodes project, job and (for
 * screenshots) row ids. That is acceptable because the bucket is never public —
 * every download goes through the API's own authenticated route, so the key is
 * only ever seen by the API — and because those ids are already visible in URLs
 * the same user has been authorised for. What it does mean is that keys must
 * never be handed to a client as a pre-signed URL, which is also why nothing in
 * this module presigns.
 *
 * The project/org prefix exists so that a future per-tenant lifecycle rule or
 * bulk delete is expressible with a prefix rather than a scan, and so a
 * mis-issued delete cannot plausibly reach across tenants by accident.
 */

/** Extensions for the content types the two artifact tables accept. */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * The file extension for a stored content type, or `bin` for one the table's
 * CHECK does not currently allow.
 *
 * Not an error: the extension is cosmetic (the bytes and the content type in
 * the row are authoritative, and the download route sets the header from the
 * row), so an unrecognised type produces an unhelpful-but-harmless key rather
 * than failing a write whose data is fine.
 */
function extensionFor(contentType: string): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
}

export function recordingKey(input: {
  projectId: string;
  jobId: string;
  contentType: string;
}): string {
  return `recordings/${input.projectId}/${input.jobId}.${extensionFor(input.contentType)}`;
}

export function screenshotKey(input: {
  projectId: string;
  jobId: string;
  screenshotId: string;
  contentType: string;
}): string {
  return (
    `screenshots/${input.projectId}/${input.jobId}/` +
    `${input.screenshotId}.${extensionFor(input.contentType)}`
  );
}

/**
 * One bundle file. The bundle's own relative path is kept as the tail of the
 * key, so the object tree mirrors the extension's source tree — which is the
 * shape an operator reading the bucket expects, and the shape a future "download
 * the whole extension" would want to zip back up.
 *
 * Path segments are re-checked here even though `bundle.ts` already rejects
 * `..`, absolute paths and backslashes. This is the last point before a
 * caller-supplied string becomes a URL path, and the cost of the check is a
 * regex; the cost of getting it wrong is addressing an object outside the
 * extension's prefix.
 */
export function extensionFileKey(input: {
  organizationId: string;
  extensionId: string;
  path: string;
}): string {
  const segments = input.path.split("/");
  const unsafe =
    input.path.startsWith("/") ||
    input.path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) {
    throw new Error(`refusing to build an object key from an unsafe path: ${input.path}`);
  }
  return `extensions/${input.organizationId}/${input.extensionId}/${input.path}`;
}
