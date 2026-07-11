import { z } from "zod";

export const USERNAME_REGEX = /^[a-z0-9_-]{3,32}$/;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, "Username must be 3–32 characters: lowercase letters, numbers, _ or -");

export const confirmUsernameSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
});

export const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
});
