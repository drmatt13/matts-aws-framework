#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/518f79d59ebe3ed7d871ed006f788079416d1da9cdafa9b9ff66b18457871881/contract';
import endContract from '../../snapshots/518f79d59ebe3ed7d871ed006f788079416d1da9cdafa9b9ff66b18457871881/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47/contract';
import startContract from '../../snapshots/8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'projects',
        columns: [
          col('archived', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('created_at', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1', typeParams: { precision: 6 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('owner_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1', typeParams: { precision: 6 } },
          }),
        ],
        constraints: [primaryKey(['id'], { name: 'projects_pkey' })],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projects',
        index: 'projects_owner_id_idx',
        columns: ['owner_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'projects',
        foreignKey: {
          name: 'projects_owner_id_fkey',
          columns: ['owner_id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
