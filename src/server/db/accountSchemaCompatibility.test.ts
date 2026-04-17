import { describe, expect, it } from 'vitest';
import { ensureAccountSchemaCompatibility, type AccountSchemaInspector } from './accountSchemaCompatibility.js';

function createInspector(
  dialect: AccountSchemaInspector['dialect'],
  options?: {
    hasAccountsTable?: boolean;
    existingColumns?: string[];
  },
) {
  const executedSql: string[] = [];
  const hasAccountsTable = options?.hasAccountsTable ?? true;
  const existingColumns = new Set(options?.existingColumns ?? []);

  const inspector: AccountSchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'accounts' && hasAccountsTable;
    },
    async columnExists(table, column) {
      return table === 'accounts' && existingColumns.has(column);
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureAccountSchemaCompatibility', () => {
  it.each([
    {
      dialect: 'sqlite' as const,
      expectedSql: ['ALTER TABLE accounts ADD COLUMN endpoint_overrides text;'],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: ['ALTER TABLE `accounts` ADD COLUMN `endpoint_overrides` TEXT NULL'],
    },
    {
      dialect: 'postgres' as const,
      expectedSql: ['ALTER TABLE "accounts" ADD COLUMN "endpoint_overrides" TEXT'],
    },
  ])('adds missing account compatibility columns for $dialect', async ({ dialect, expectedSql }) => {
    const { inspector, executedSql } = createInspector(dialect);

    await ensureAccountSchemaCompatibility(inspector);

    expect(executedSql).toEqual(expectedSql);
  });

  it('skips schema changes when accounts table does not exist', async () => {
    const { inspector, executedSql } = createInspector('sqlite', { hasAccountsTable: false });

    await ensureAccountSchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
