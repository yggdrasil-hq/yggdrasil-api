import {
  encodePathSegments,
  signRequest,
  type SigningCredentials,
} from "./signature.js";

/**
 * Issue #30: the object-storage client, and the interface the repositories
 * depending on storage are written against.
 *
 * The interface is deliberately four methods. Everything downstream of it —
 * recordings, screenshots and extension bundles — only ever needs to write one
 * artifact under a key, read it back, remove it, and know the bucket is there.
 * A narrower interface is what keeps the swap in `signature.ts`'s header
 * comment a real option: an SDK-shaped client behind these four methods is a
 * fifteen-line adapter.
 */

export interface ObjectStorageConfig {
  /** e.g. `http://minio:9000`. Includes the scheme and, for a non-default port, the port. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  /**
   * `true` for MinIO and most self-hosted gateways, where the bucket is a path
   * segment (`http://host:9000/bucket/key`). `false` for AWS S3's default,
   * where it is a subdomain (`https://bucket.s3.amazonaws.com/key`). The
   * compose files set it explicitly rather than inferring it from the endpoint,
   * because "is this AWS or not" is not something a hostname answers reliably.
   */
  forcePathStyle: boolean;
  /**
   * Bounds one request. There is no default timeout on `fetch`, so without this
   * an unreachable endpoint would hold the request — and, on the upload path, a
   * job's completion report — open indefinitely.
   */
  timeoutMs?: number;
}

/** The default is generous for a 25 MB upload over a LAN, and finite. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A storage failure, with the detail a caller needs to act on.
 *
 * `code` is separate from `message` because the callers *branch* on it: a
 * missing object is a 404 to the client and `null` from `get`, while anything
 * else is a 5xx and a log line. Parsing that out of a message string would be
 * the kind of thing that breaks the first time someone rewords it.
 */
export class ObjectStorageError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "access_denied"
      | "already_exists"
      | "unreachable"
      | "malformed_response"
      | "unknown",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

export interface ObjectStorage {
  /**
   * Idempotently ensures the bucket exists. Called once lazily rather than at
   * boot: MinIO does not create buckets on demand, so without this every write
   * fails with `NoSuchBucket` on a fresh install — and a boot-time check would
   * make the API fail to start whenever object storage was briefly down, which
   * is a worse failure than a slow first upload.
   */
  ensureBucket(): Promise<void>;
  putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** The bytes, or null when the key does not exist. */
  getObject(key: string): Promise<Buffer | null>;
  /** Removes the key. Removing an absent key is not an error. */
  deleteObject(key: string): Promise<void>;
}

/**
 * S3-compatible object storage — MinIO in both compose files, AWS S3 or any
 * compatible gateway elsewhere.
 *
 * Throws `ObjectStorageError` for every failure, so a caller never has to
 * distinguish "the network broke" from "the server said no" from an incidental
 * `TypeError`; the code carries that.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly timeoutMs: number;
  private bucketChecked: Promise<void> | null = null;

  constructor(private readonly config: ObjectStorageConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get credentials(): SigningCredentials {
    return {
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    };
  }

  /**
   * The URL for an object (or, with no key, the bucket).
   *
   * Path style puts the bucket in the path; virtual-host style prefixes it to
   * the hostname. Both are built from the *parsed* endpoint so a configured
   * endpoint with a path prefix (a gateway behind a reverse proxy, e.g.
   * `https://host/s3`) keeps that prefix instead of having it silently dropped.
   */
  private urlFor(key?: string): { url: string; host: string; path: string } {
    const endpoint = new URL(this.config.endpoint);
    const basePath = endpoint.pathname.replace(/\/$/, "");
    const bucket = this.config.bucket;

    if (this.config.forcePathStyle) {
      const path = `${basePath}/${bucket}${key ? `/${key}` : ""}`;
      // `host` is the signed header, and it must include the port when the
      // endpoint has one — `new URL().host` does, `.hostname` does not.
      return { url: `${endpoint.origin}${path}`, host: endpoint.host, path };
    }

    const host = `${bucket}.${endpoint.host}`;
    const path = `${basePath}${key ? `/${key}` : ""}`;
    return { url: `${endpoint.protocol}//${host}${path}`, host, path };
  }

  private async send(input: {
    method: string;
    key?: string;
    body?: Buffer;
    contentType?: string;
    /** 404 is an answer rather than a failure for `get`. */
    allowNotFound?: boolean;
  }): Promise<Response | null> {
    const body = input.body ?? Buffer.alloc(0);
    const { url, host, path } = this.urlFor(input.key);
    const canonicalUri = encodePathSegments(path) || "/";

    const signed = signRequest(this.credentials, {
      method: input.method,
      canonicalUri,
      canonicalQuery: "",
      host,
      region: this.config.region,
      payload: body,
      ...(input.contentType ? { extraHeaders: { "content-type": input.contentType } } : {}),
    });

    let response: Response;
    try {
      const request: RequestInit = {
        method: input.method,
        headers: signed.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        // Node's `Buffer` **is** a `Uint8Array` and `fetch` accepts it, but the
        // DOM lib's `BodyInit` union in this TypeScript version does not include
        // the generic `Uint8Array<ArrayBufferLike>` that `Buffer` widens to. The
        // cast is a type-level accommodation only; the bytes sent are the
        // buffer, with no copy of a 25 MB recording.
        ...(body.length > 0 ? { body: body as unknown as BodyInit } : {}),
      };
      response = await fetch(url, request);
    } catch (error) {
      // A timeout, a DNS failure and a refused connection all land here, and
      // all mean the same thing to a caller: storage is not answerable.
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new ObjectStorageError(
        `object storage unreachable at ${this.config.endpoint}: ${reason}`,
        "unreachable",
      );
    }

    if (response.ok) return response;
    if (input.allowNotFound && response.status === 404) return null;

    const code = await readErrorCode(response);
    throw new ObjectStorageError(
      `object storage ${input.method} ${path} failed: ${response.status} ${code ?? response.statusText}`,
      classify(response.status, code),
      response.status,
    );
  }

  /**
   * Creates the bucket if it is absent, at most once per process.
   *
   * The memoised promise is what makes it "at most once" rather than "usually
   * once": concurrent first writes must not each issue a create, and they must
   * all wait for the same answer. The promise is cleared on failure so a
   * transient outage does not poison the process for its lifetime — the next
   * write retries rather than inheriting a rejected promise forever.
   */
  async ensureBucket(): Promise<void> {
    if (!this.bucketChecked) {
      this.bucketChecked = this.createBucketIfAbsent().catch((error: unknown) => {
        this.bucketChecked = null;
        throw error;
      });
    }
    return this.bucketChecked;
  }

  private async createBucketIfAbsent(): Promise<void> {
    try {
      await this.send({ method: "PUT" });
    } catch (error) {
      // "Already mine" and "someone else has it" are both fine here: the
      // bucket exists, which is all this method promises. Everything else is
      // the caller's problem and propagates.
      if (error instanceof ObjectStorageError && error.code === "already_exists") return;
      throw error;
    }
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    await this.ensureBucket();
    await this.send({
      method: "PUT",
      key: input.key,
      body: input.body,
      contentType: input.contentType,
    });
  }

  async getObject(key: string): Promise<Buffer | null> {
    const response = await this.send({ method: "GET", key, allowNotFound: true });
    if (!response) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(key: string): Promise<void> {
    // S3 answers 204 for a delete whether or not the key was there, so absence
    // needs no special case — "removing an absent key is not an error" is the
    // server's own semantics rather than something this client layers on.
    await this.send({ method: "DELETE", key });
  }
}

/** S3's error body is a small XML document; the code is the only part worth having. */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
  } catch {
    // A body we cannot read is not a reason to fail differently — the status
    // code already told us what we need.
    return null;
  }
}

function classify(
  status: number,
  code: string | null,
): ObjectStorageError["code"] {
  // The XML code is more specific than the status for the two cases that
  // matter: MinIO answers 409 for both "you already own this bucket" and
  // "someone else does", and 403 for both "bad credentials" and "no such
  // bucket, so I will not tell you" — and the callers branch on both.
  if (status === 404 || code === "NoSuchKey" || code === "NoSuchBucket") return "not_found";
  if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
    return "already_exists";
  }
  if (status === 401 || status === 403 || code === "AccessDenied" || code === "SignatureDoesNotMatch") {
    return "access_denied";
  }
  if (code === null && (status === 200 || status === 204)) return "malformed_response";
  return "unknown";
}

/**
 * Builds the client for a configuration, or returns null when there is none.
 *
 * Returning null rather than throwing is the whole reason the Postgres columns
 * still exist: an install with no object storage configured (every install
 * today) must keep working exactly as it does now, and the repositories degrade
 * to their previous behaviour rather than failing to start. The decision is made
 * once, here, so a caller cannot half-configure it.
 */
export function createObjectStorage(
  config: Partial<ObjectStorageConfig> | null | undefined,
): S3ObjectStorage | null {
  if (
    !config?.endpoint ||
    !config.accessKeyId ||
    !config.secretAccessKey ||
    !config.bucket
  ) {
    return null;
  }
  return new S3ObjectStorage({
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    region: config.region ?? "us-east-1",
    forcePathStyle: config.forcePathStyle ?? true,
    timeoutMs: config.timeoutMs,
  });
}
