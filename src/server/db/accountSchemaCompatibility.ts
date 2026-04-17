export type AccountSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface AccountSchemaInspector {
  dialect: AccountSchemaDialect;
  tableExists(table: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
}

export type AccountColumnCompatibilitySpec = {
  table: 'accounts';
  column: string;
  addSql: Record<AccountSchemaDialect, string>;
};

export const ACCOUNT_COLUMN_COMPATIBILITY_SPECS: AccountColumnCompatibilitySpec[] = [
  {
    table: 'accounts',
    column: 'endpoint_overrides',
    addSql: {
      sqlite: 'ALTER TABLE accounts ADD COLUMN endpoint_overrides text;',
      mysql: 'ALTER TABLE `accounts` ADD COLUMN `endpoint_overrides` TEXT NULL',
      postgres: 'ALTER TABLE "accounts" ADD COLUMN "endpoint_overrides" TEXT',
    },
  },
];

function normalizeSchemaErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

function isDuplicateColumnError(error: unknown): boolean {
  const lowered = normalizeSchemaErrorMessage(error).toLowerCase();
  return lowered.includes('duplicate column')
    || lowered.includes('already exists')
    || lowered.includes('duplicate column name');
}

async function executeAddColumn(inspector: AccountSchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

export async function ensureAccountSchemaCompatibility(inspector: AccountSchemaInspector): Promise<void> {
  for (const spec of ACCOUNT_COLUMN_COMPATIBILITY_SPECS) {
    const hasTable = await inspector.tableExists(spec.table);
    if (!hasTable) {
      continue;
    }

    const hasColumn = await inspector.columnExists(spec.table, spec.column);
    if (!hasColumn) {
      await executeAddColumn(inspector, spec.addSql[inspector.dialect]);
    }
  }
}
