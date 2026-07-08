import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assertSecretsEncryptionKey } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/** Encrypts plaintext with AES-256-GCM. Blob format: `iv:authTag:ciphertext` (base64 segments). */
export function encrypt(plaintext: string): string {
  const key = assertSecretsEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(":");
}

export function decrypt(blob: string): string {
  const key = assertSecretsEncryptionKey();
  const [ivB64, authTagB64, ciphertextB64] = blob.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret blob");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
