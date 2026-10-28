import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261027000000WageringSchema } from './Migration20261027000000WageringSchema';
import { Migration20261027000100MessagingSchema } from './Migration20261027000100MessagingSchema';
import { Migration20261028000000OutboxHeadOfLine } from './Migration20261028000000OutboxHeadOfLine';

export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261027000000WageringSchema', class: Migration20261027000000WageringSchema },
  { name: 'Migration20261027000100MessagingSchema', class: Migration20261027000100MessagingSchema },
  { name: 'Migration20261028000000OutboxHeadOfLine', class: Migration20261028000000OutboxHeadOfLine },
];
