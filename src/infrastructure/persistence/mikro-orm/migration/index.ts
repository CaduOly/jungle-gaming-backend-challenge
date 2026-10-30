import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261027000000WageringSchema } from './Migration20261027000000WageringSchema';
import { Migration20261027000100MessagingSchema } from './Migration20261027000100MessagingSchema';
import { Migration20261028000000OutboxHeadOfLine } from './Migration20261028000000OutboxHeadOfLine';
import { Migration20261028000100BalanceLimitExceeded } from './Migration20261028000100BalanceLimitExceeded';
import { Migration20261028000200OutboxCommitSequence } from './Migration20261028000200OutboxCommitSequence';
import { Migration20261029000000ReferenceSchemaGuards } from './Migration20261029000000ReferenceSchemaGuards';

export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261027000000WageringSchema', class: Migration20261027000000WageringSchema },
  { name: 'Migration20261027000100MessagingSchema', class: Migration20261027000100MessagingSchema },
  { name: 'Migration20261028000000OutboxHeadOfLine', class: Migration20261028000000OutboxHeadOfLine },
  { name: 'Migration20261028000100BalanceLimitExceeded', class: Migration20261028000100BalanceLimitExceeded },
  { name: 'Migration20261028000200OutboxCommitSequence', class: Migration20261028000200OutboxCommitSequence },
  { name: 'Migration20261029000000ReferenceSchemaGuards', class: Migration20261029000000ReferenceSchemaGuards },
];
