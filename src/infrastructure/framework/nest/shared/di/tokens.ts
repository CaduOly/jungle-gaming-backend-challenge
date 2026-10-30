/** Tokens de DI: só existem na camada do Nest, o negócio nunca enxerga eles. */
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const PAYLOAD_HASHER = Symbol('PAYLOAD_HASHER');
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
export const PENDING_REFERENCE_BACKOFF = Symbol('PENDING_REFERENCE_BACKOFF');
export const HTTP_CONFIG = Symbol('HTTP_CONFIG');
export const READINESS_PROBE = Symbol('READINESS_PROBE');
export const LOGGER = Symbol('LOGGER');
export const METRICS = Symbol('METRICS');
/** Unit of work do WAGERING_PERSISTENCE por trás do ObservedUnitOfWork (lock wait e conflitos de lock). */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const READINESS_DETAILS = Symbol('READINESS_DETAILS');
/** Persistência trocável: fakes in-memory nas suites e2e, PostgreSQL na app rodando. */
export const WAGERING_PERSISTENCE = Symbol('WAGERING_PERSISTENCE');

export const CREATE_WALLET = Symbol('CreateWallet');
export const GET_WALLET = Symbol('GetWallet');
export const GET_LEDGER = Symbol('GetLedger');
export const RECONCILE_WALLET = Symbol('ReconcileWallet');
export const PROCESS_WAGER_TRANSACTION = Symbol('ProcessWagerTransaction');
export const GET_WAGER_TRANSACTION = Symbol('GetWagerTransaction');
