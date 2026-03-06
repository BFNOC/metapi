import { describe, expect, it } from 'vitest';
import { maskConnectionString, normalizeMigrationInput } from './databaseMigrationService.js';

describe('databaseMigrationService', () => {
  it('accepts postgres migration input with normalized url', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: '  postgres://user:pass@db.example.com:5432/metapi  ',
      overwrite: true,
    });

    expect(normalized).toEqual({
      dialect: 'postgres',
      connectionString: 'postgres://user:pass@db.example.com:5432/metapi',
      overwrite: true,
      ssl: false,
    });
  });

  it('accepts mysql migration input', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://root:pass@db.example.com:3306/metapi',
    });

    expect(normalized.dialect).toBe('mysql');
    expect(normalized.overwrite).toBe(true);
    expect(normalized.ssl).toBe(false);
  });

  it('accepts sqlite file migration target path', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'sqlite',
      connectionString: './data/target.db',
      overwrite: false,
    });

    expect(normalized).toEqual({
      dialect: 'sqlite',
      connectionString: './data/target.db',
      overwrite: false,
      ssl: false,
    });
  });

  it('rejects unknown dialect', () => {
    expect(() => normalizeMigrationInput({
      dialect: 'oracle',
      connectionString: 'oracle://db',
    } as any)).toThrow(/鏂硅█|sqlite\/mysql\/postgres/i);
  });

  it('rejects postgres input when scheme mismatches', () => {
    expect(() => normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: 'mysql://root:pass@127.0.0.1:3306/metapi',
    })).toThrow(/postgres/i);
  });

  it('masks connection string credentials', () => {
    const masked = maskConnectionString('postgres://admin:super-secret@db.example.com:5432/metapi');
    expect(masked).toBe('postgres://admin:***@db.example.com:5432/metapi');
  });

  it('normalizes ssl boolean from input', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@tidb.example.com:4000/db',
      ssl: true,
    });
    expect(normalized.ssl).toBe(true);
  });

  it('defaults ssl to false when not provided', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: 'postgres://user:pass@db.example.com:5432/metapi',
    });
    expect(normalized.ssl).toBe(false);
  });

  it('parses ssl from string values', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@host:3306/db',
      ssl: '1',
    });
    expect(normalized.ssl).toBe(true);
  });

  it('parses ssl false from string "0"', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@host:3306/db',
      ssl: '0',
    });
    expect(normalized.ssl).toBe(false);
  });
});

