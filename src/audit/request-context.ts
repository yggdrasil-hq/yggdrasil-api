import type { NextFunction, Request, Response } from "express";

/**
 * ADR 028 item 5: the request metadata every audit write wants, captured once
 * per request by a tiny middleware rather than threaded through every route
 * handler's arguments. `res.locals` is the natural carrier — it is already
 * per-request and already scoped to the response the handler holds.
 */
export interface AuditRequestContext {
  ip: string | null;
  userAgent: string | null;
}

const AUDIT_CONTEXT_KEY = "auditContext";

const EMPTY_CONTEXT: AuditRequestContext = { ip: null, userAgent: null };

/**
 * Mounted once, app-wide, before any router (see app.ts). `app.set("trust
 * proxy", 1)` is already set, so `req.ip` is the real client address behind
 * the deploy's nginx rather than the proxy's.
 */
export function auditContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.locals[AUDIT_CONTEXT_KEY] = {
    ip: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
  } satisfies AuditRequestContext;
  next();
}

/**
 * Reads back what the middleware captured. Tolerates a missing context (a
 * handler exercised in a test without the middleware mounted) by returning
 * nulls rather than throwing — an audit record with no ip is still a useful
 * record.
 */
export function auditContextFrom(res: Response): AuditRequestContext {
  const context = (res.locals as Record<string, unknown> | undefined)?.[
    AUDIT_CONTEXT_KEY
  ] as AuditRequestContext | undefined;
  return context ?? EMPTY_CONTEXT;
}
