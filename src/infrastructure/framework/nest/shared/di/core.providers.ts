import type { Provider } from '@nestjs/common';
import { ExponentialBackoff } from '../../../../../business/shared/policy/exponential-backoff';
import { createProviderIdentity } from '../../../../auth/provider-identity.factory';
import { SystemClock } from '../../../../clock/system-clock';
import { readAuthConfig } from '../../../../config/auth-config';
import { readPendingReferenceBackoff } from '../../../../config/pending-reference-config';
import { Sha256PayloadHasher } from '../../../../hashing/sha256-payload-hasher';
import { UuidV7IdGenerator } from '../../../../id/uuid-v7-id-generator';
import { readHttpConfig } from '../http-config';
import { CLOCK, HTTP_CONFIG, ID_GENERATOR, PAYLOAD_HASHER, PENDING_REFERENCE_BACKOFF, PROVIDER_IDENTITY } from './tokens';

/** Production adapters; a test overrides any of them by providing the same token again. */
export const coreProviders = (env: Readonly<Record<string, string | undefined>>): Provider[] => [
  { provide: CLOCK, useClass: SystemClock },
  { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
  { provide: PAYLOAD_HASHER, useClass: Sha256PayloadHasher },
  { provide: PROVIDER_IDENTITY, useFactory: () => createProviderIdentity(readAuthConfig(env)) },
  { provide: HTTP_CONFIG, useValue: readHttpConfig(env) },
  {
    provide: PENDING_REFERENCE_BACKOFF,
    useFactory: () => new ExponentialBackoff({ ...readPendingReferenceBackoff(env), random: Math.random }),
  },
];
