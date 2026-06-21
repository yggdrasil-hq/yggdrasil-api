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

export function meetsMinimumInterval(cron: string): boolean {
  const presets = Object.values(TEST_SCHEDULE_PRESETS);
  if (presets.includes(cron as (typeof presets)[number])) {
    return true;
  }
  // Custom cron: require at least hourly (no sub-hour patterns in v1).
  return !/\*\/[1-9]\s+\*\s+\*\s+\*\s+\*/.test(cron) && !/^\* \* \* \* \*$/.test(cron);
}
