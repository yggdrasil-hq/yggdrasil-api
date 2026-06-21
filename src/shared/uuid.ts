import { z } from "zod";

export function isUuid(value: string): boolean {
  return z.string().uuid().safeParse(value).success;
}
