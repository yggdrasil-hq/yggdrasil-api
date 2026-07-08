// Runs before any test file's own imports evaluate `config.ts` (which reads
// these at module-load time) — needed so secrets-encryption tests don't have
// to depend on the real dev .env.
process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_API_TOKEN ??= "test-internal-api-token";
