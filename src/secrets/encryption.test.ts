import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./encryption.js";

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext value", () => {
    const blob = encrypt("super-secret-value");
    expect(decrypt(blob)).toBe("super-secret-value");
  });

  it("produces a different ciphertext for the same plaintext each time (random IV)", () => {
    const first = encrypt("same-value");
    const second = encrypt("same-value");
    expect(first).not.toBe(second);
    expect(decrypt(first)).toBe("same-value");
    expect(decrypt(second)).toBe("same-value");
  });

  it("rejects a tampered ciphertext (GCM auth tag mismatch)", () => {
    const blob = encrypt("tamper-me");
    const [iv, authTag, ciphertext] = blob.split(":");
    const tamperedCiphertext = Buffer.from(ciphertext, "base64");
    tamperedCiphertext[0] ^= 0xff;
    const tampered = [iv, authTag, tamperedCiphertext.toString("base64")].join(":");

    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decrypt("not-a-valid-blob")).toThrow("Malformed encrypted secret blob");
  });
});
