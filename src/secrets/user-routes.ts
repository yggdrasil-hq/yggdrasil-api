import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { UserSecretRepository } from "./user-repository.js";

const upsertSecretSchema = z.object({
  key: z.string().trim().min(1).max(128),
  value: z.string(),
});

/** Account-level default secrets — today just the model-config bundle (ADR 007). */
export function createUserSecretsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  userSecrets: UserSecretRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.get("/secrets", requireAuth, async (req, res) => {
    const secrets = await deps.userSecrets.listForUser(req.currentUser!.id);
    res.json(secrets);
  });

  router.put("/secrets", requireAuth, async (req, res) => {
    const parsed = upsertSecretSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const secret = await deps.userSecrets.upsert(
      req.currentUser!.id,
      parsed.data.key,
      parsed.data.value,
    );
    res.status(200).json(secret);
  });

  router.delete("/secrets/:secretId", requireAuth, async (req, res) => {
    const secretId = routeParam(req.params.secretId);
    if (!isUuid(secretId)) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const deleted = await deps.userSecrets.delete(req.currentUser!.id, secretId);
    if (!deleted) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    res.status(204).send();
  });

  return router;
}
