import { z } from "zod";

export const USERNAME_REGEX = /^[a-z0-9_-]{3,32}$/;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, "Username must be 3–32 characters: lowercase letters, numbers, _ or -");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters");

export const signupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

export const confirmUsernameSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
});

export const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
});

export const setPasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: passwordSchema,
});
