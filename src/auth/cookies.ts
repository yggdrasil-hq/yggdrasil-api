import type { CookieOptions, Response } from "express";
import { config } from "../config.js";

export function sessionCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.nodeEnv === "production",
    domain: config.sessionCookieDomain,
    maxAge: maxAgeMs,
  };
}

export function setSessionCookie(res: Response, sessionId: string, rememberMe: boolean): void {
  const maxAge = rememberMe ? config.sessionTtl.rememberMs : config.sessionTtl.defaultMs;
  res.cookie(config.cookieName, sessionId, sessionCookieOptions(maxAge));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.nodeEnv === "production",
    domain: config.sessionCookieDomain,
  });
}
