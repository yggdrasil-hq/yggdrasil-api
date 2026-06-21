import type pg from "pg";
import type { Test } from "./types.js";

interface TestRow {
  id: string;
  project_id: string;
  name: string;
  spec_markdown: string;
  schedule_cron: string;
  enabled: boolean;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const testColumns = `
  id, project_id, name, spec_markdown, schedule_cron, enabled, last_run_at,
  created_at, updated_at
`;

function mapTest(row: TestRow): Test {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    specMarkdown: row.spec_markdown,
    scheduleCron: row.schedule_cron,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TestRepository {
  constructor(private readonly db: pg.Pool) {}

  async listByProject(projectId: string): Promise<Test[]> {
    const result = await this.db.query<TestRow>(
      `SELECT ${testColumns}
       FROM tests
       WHERE project_id = $1
       ORDER BY name ASC`,
      [projectId],
    );
    return result.rows.map(mapTest);
  }

  async findById(projectId: string, testId: string): Promise<Test | null> {
    const result = await this.db.query<TestRow>(
      `SELECT ${testColumns}
       FROM tests
       WHERE project_id = $1 AND id = $2`,
      [projectId, testId],
    );
    return result.rows[0] ? mapTest(result.rows[0]) : null;
  }

  async create(input: {
    projectId: string;
    name: string;
    specMarkdown: string;
    scheduleCron: string;
    enabled?: boolean;
  }): Promise<Test> {
    const result = await this.db.query<TestRow>(
      `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${testColumns}`,
      [
        input.projectId,
        input.name,
        input.specMarkdown,
        input.scheduleCron,
        input.enabled ?? true,
      ],
    );
    return mapTest(result.rows[0]);
  }

  async update(
    testId: string,
    input: {
      name?: string;
      specMarkdown?: string;
      scheduleCron?: string;
      enabled?: boolean;
    },
  ): Promise<Test | null> {
    const result = await this.db.query<TestRow>(
      `UPDATE tests
       SET name = COALESCE($2, name),
           spec_markdown = COALESCE($3, spec_markdown),
           schedule_cron = COALESCE($4, schedule_cron),
           enabled = COALESCE($5, enabled),
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${testColumns}`,
      [
        testId,
        input.name ?? null,
        input.specMarkdown ?? null,
        input.scheduleCron ?? null,
        input.enabled ?? null,
      ],
    );
    return result.rows[0] ? mapTest(result.rows[0]) : null;
  }
}
