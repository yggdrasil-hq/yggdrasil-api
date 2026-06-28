import { createSign } from "node:crypto";

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  );
  const signInput = `${header}.${payload}`;
  const key = privateKeyPem.replace(/\\n/g, "\n");
  const signature = createSign("RSA-SHA256").update(signInput).sign(key, "base64url");
  return `${signInput}.${signature}`;
}
