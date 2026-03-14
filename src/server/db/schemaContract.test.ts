import { describe, expect, it } from 'vitest';
import { buildSchemaContractFromSqliteMigrations } from './schemaContract.js';

describe('schema contract generation', () => {
  it('captures the current schema shape from sqlite migrations', () => {
    const contract = buildSchemaContractFromSqliteMigrations();

    expect(contract.tables.sites.columns.status).toMatchObject({
      logicalType: 'text',
      notNull: true,
      primaryKey: false,
    });
    expect(contract.tables.account_tokens.columns.token_group).toBeDefined();
    expect(contract.tables.site_disabled_models).toBeDefined();
    expect(contract.indexes).toContainEqual(
      expect.objectContaining({ name: 'sites_status_idx', table: 'sites', unique: false }),
    );
    expect(contract.uniques).toContainEqual(
      expect.objectContaining({
        name: 'site_disabled_models_site_model_unique',
        table: 'site_disabled_models',
        columns: ['site_id', 'model_name'],
      }),
    );
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'site_disabled_models',
        columns: ['site_id'],
        referencedTable: 'sites',
        referencedColumns: ['id'],
      }),
    );
  });
});
