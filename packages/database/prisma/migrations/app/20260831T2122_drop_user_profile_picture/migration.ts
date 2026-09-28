#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47/contract';
import endContract from '../../snapshots/8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f5a32fb7683e61475d275aaf2c53c4a994e843207b94af3e924e8ec05968f167/contract';
import startContract from '../../snapshots/f5a32fb7683e61475d275aaf2c53c4a994e843207b94af3e924e8ec05968f167/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [this.dropColumn({ schema: 'public', table: 'users', column: 'profile_picture' })];
  }
}

MigrationCLI.run(import.meta.url, M);
