import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * Gates the internal deploy-time secrets endpoint behind a shared bearer
 * token — the Orchestrator is the only caller (ADR 003 §4: one cluster/one
 * Orchestrator instance per deployment), so a single shared token is enough.
 */
export function requireInternalApiToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.internalApiToken;
  if (!expected) {
    res.status(503).json({ error: "Internal API is not configured" });
    return;
  }

  const header = req.header("authorization");
  const received = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!received) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(received);
  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    res.status(401).json({ error: "Invalid bearer token" });
    return;
  }

  next();
}
