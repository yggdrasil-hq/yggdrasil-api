import crypto from "node:crypto";

/**
 * Issue #30: AWS Signature Version 4, for the S3 operations this API issues.
 *
 * **Why this exists rather than `@aws-sdk/client-s3`.** The API talks to object
 * storage for four operations — create a bucket, put, get and delete — against a
 * single endpoint, with a single set of credentials, in a known region.
 * `@aws-sdk/client-s3` is a maintained, well-tested client and
 * it would cover this correctly. Against that: it pulls a few hundred transitive
 * packages into an image whose runtime dependencies are currently eight, for
 * about a hundred and fifty lines of signing we can read end to end and have
 * exercised against a real MinIO. That is a real trade rather than a clear win,
 * so it is written down here instead of being implied — a reader deciding
 * whether to swap in the SDK deserves to know the case was considered. ADR 029
 * deferred this work partly because it "would need to hand-roll SigV4"; the
 * signing itself turned out to be the small part.
 *
 * This module owns only the signature. Request construction, error mapping and
 * response handling live in `client.ts`, so the parts that talk to the network
 * are separate from the part that does arithmetic on strings.
 *
 * Deliberately not implemented, because nothing here needs them: presigned URLs
 * (the download routes stream through the API, so authorisation stays in one
 * place), chunked/streaming uploads (artifacts are already bounded buffers by
 * the time they reach here), session tokens (static keys only), and
 * `S3 Signature V2`.
 */

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignRequestInput {
  method: string;
  /** Path-style: `/bucket/key`. Must already be URI-encoded per segment. */
  canonicalUri: string;
  /** Already-encoded `k=v` pairs, sorted. Empty string when there are none. */
  canonicalQuery: string;
  host: string;
  region: string;
  /**
   * Extra headers to sign, lowercase names to values. `host`, `x-amz-date` and
   * `x-amz-content-sha256` are added here rather than by the caller, because
   * all three are mandatory and a caller that forgot one would produce a
   * signature failure rather than a compile error.
   */
  extraHeaders?: Record<string, string>;
  payload: Buffer;
  /** Injectable so a test can pin a signature rather than depend on the clock. */
  now?: Date;
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** Exposed for tests and for error messages that need to name what was signed. */
  canonicalRequest: string;
  stringToSign: string;
  amzDate: string;
}

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/**
 * RFC 3986 encoding, which is what SigV4 requires and what
 * `encodeURIComponent` does *not* implement: it leaves `!`, `'`, `(`, `)` and
 * `*` unescaped, and S3 keys may legally contain all of them. A key that
 * differed only in one of those characters would sign fine and then
 * `SignatureDoesNotMatch` against the server, which is a miserable thing to
 * debug — so this is here rather than `encodeURIComponent`.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encodes an object key or bucket name as a canonical URI path.
 *
 * Splits on `/` and encodes each segment, so the separators survive — encoding
 * the whole string would turn `a/b` into `a%2Fb`, which names a different
 * object. Empty segments are preserved so a key cannot silently normalise
 * (`a//b` is not `a/b`).
 */
export function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

/** The `YYYYMMDDTHHMMSSZ` stamp SigV4 uses in headers and in the scope. */
export function amzDateOf(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Derives the request signing key: four chained HMACs over the date, region,
 * service and a terminating literal. The chain is what makes a key scoped to
 * one day and one region, so a leaked signature cannot be replayed elsewhere.
 */
export function deriveSigningKey(
  credentials: SigningCredentials,
  dateStamp: string,
  region: string,
  service = "s3",
): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

/** Signs one request. Pure: no clock of its own beyond the injectable `now`. */
export function signRequest(
  credentials: SigningCredentials,
  input: SignRequestInput,
): SignedRequest {
  const amzDate = amzDateOf(input.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.payload);

  // Lowercased because SigV4 canonicalises header names, and sorted because the
  // canonical form is defined over sorted names — not, importantly, over the
  // order the caller happened to write them in.
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", deriveSigningKey(credentials, dateStamp, input.region))
    .update(stringToSign)
    .digest("hex");

  return {
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    amzDate,
  };
}
