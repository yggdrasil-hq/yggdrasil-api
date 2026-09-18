import { minimumIntervalMs } from "../scheduling/cron.js";

export interface Test {
  id: string;
  projectId: string;
  name: string;
  specMarkdown: string;
  scheduleCron: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicTest {
  id: string;
  projectId: string;
  name: string;
  specMarkdown: string;
  scheduleCron: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicTest(test: Test): PublicTest {
  return {
    id: test.id,
    projectId: test.projectId,
    name: test.name,
    specMarkdown: test.specMarkdown,
    scheduleCron: test.scheduleCron,
    enabled: test.enabled,
    lastRunAt: test.lastRunAt?.toISOString() ?? null,
    createdAt: test.createdAt.toISOString(),
    updatedAt: test.updatedAt.toISOString(),
  };
}

export const TEST_SCHEDULE_PRESETS = {
  hourly: "0 * * * *",
  every6Hours: "0 */6 * * *",
  daily9am: "0 9 * * *",
  weeklyMonday9am: "0 9 * * 1",
} as const;

export function isValidCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => part.length > 0);
}

/** The interval rule the UI states: "Minimum interval is 1 hour". */
export const MINIMUM_SCHEDULE_INTERVAL_MS = 60 * 60 * 1000;

export function meetsMinimumInterval(cron: string, at: Date = new Date()): boolean {
  const presets = Object.values(TEST_SCHEDULE_PRESETS);
  if (presets.includes(cron as (typeof presets)[number])) {
    return true;
  }

  // Custom cron: expand it and measure the real interval between occurrences.
  // Pattern-matching the string cannot enforce this — `* 10 * * *`,
  // `0-59 10 * * *` and `* * * * 1` all look like ordinary expressions and all
  // fire every minute, and each `test_run` is a real cluster job.
  const interval = minimumIntervalMs(cron, at);
  if (interval === null) {
    // Nothing to measure — either the expression is malformed, or it matches
    // fewer than two occurrences inside the lookback window (e.g. `0 0 29 2 1`,
    // Feb 29 *and* a Monday). Neither can fire too often, so neither is this
    // rule's business; `isValidCronExpression` is the malformed-expression gate.
    return true;
  }

  return interval >= MINIMUM_SCHEDULE_INTERVAL_MS;
}
