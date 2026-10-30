import { Migration } from '@mikro-orm/migrations';

/*
 * Wallets, wager transactions e o ledger imutável. Toda invariante do CHALLENGE.md §5.9/§6 mora aqui, então ela
 * vale mesmo se o código da aplicação estiver errado ou se várias instâncias correrem juntas.
 *
 * Violação de trigger levanta SQLSTATE 23001 (restrict_violation) para a aplicação conseguir classificar como erro
 * permanente de integridade.
 *
 * OPENING (wallet aberta com saldo > 0) é gravado como uma wager transaction normal para o ledger sempre ter um
 * transaction_id e as FKs compostas fecharem:
 *   provider_id             = 'system' (reservado: só OPENING pode usar, e OPENING só pode usar ele)
 *   external_transaction_id = idempotency_key = 'opening:<walletId>'  -> no máximo um OPENING por wallet
 *   status                  = 'PROCESSED', sem reference, round_id/game_id podem ser NULL.
 *
 * Rejeição CURRENCY_MISMATCH tem que ser persistida (o replay retorna 422), mas a currency dela difere da currency
 * da wallet, o que quebraria a FK (wallet_id, currency). O `wallet_currency` é uma coluna gerada que é NULL só para
 * essa rejeição; a FK composta usa MATCH SIMPLE e é pulada nesse caso, enquanto o wallet_id mantém a FK própria.
 * Para toda outra linha a FK força currency = currency da wallet.
 *
 * O mesmo truque amarra o player_id ao player da wallet: o `wallet_player_id` é NULL só numa rejeição
 * WALLET_PLAYER_MISMATCH, que é persistida (para o replay continuar respondendo 422) com o player que o provider
 * mandou. WALLET_NOT_FOUND nunca é persistido, já que a FK da wallet não tem para onde apontar.
 *
 * Reference fica dentro da wallet: (reference_transaction_id, wallet_id) → (id, wallet_id), então um reversal na
 * wallet B nunca consegue ocupar o slot de reversal único de um BET na wallet A.
 *
 * Entrada no ledger só existe para transação PROCESSED: o `transaction_status` é uma constante gerada 'PROCESSED' e
 * a FK (transaction_id, wallet_id, transaction_status) → (id, wallet_id, status) falha para qualquer outro status.
 * Isso é estável já que PROCESSED é terminal (trigger abaixo).
 */
const UP = /* sql */ `
CREATE TABLE wallets (
  id          uuid          NOT NULL,
  player_id   uuid          NOT NULL,
  currency    text          NOT NULL,
  balance     numeric(20,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_pkey PRIMARY KEY (id),
  CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency),
  CONSTRAINT wallets_id_player_unique UNIQUE (id, player_id)
);

CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets are never deleted (wallet %)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable wallet columns cannot change (wallet %)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'wallet version cannot go back from % to % (wallet %)', OLD.version, NEW.version, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_guard BEFORE UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_guard();

CREATE FUNCTION reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TABLE wager_transactions (
  id                                uuid          NOT NULL,
  provider_id                       text          NOT NULL,
  external_transaction_id           text          NOT NULL,
  idempotency_key                   text          NOT NULL,
  payload_hash                      text          NOT NULL,
  wallet_id                         uuid          NOT NULL,
  player_id                         uuid          NOT NULL,
  round_id                          text,
  game_id                           text,
  kind                              text          NOT NULL,
  status                            text          NOT NULL,
  amount                            numeric(20,2) NOT NULL,
  currency                          text          NOT NULL,
  wallet_currency                   text GENERATED ALWAYS AS (
                                      CASE WHEN failure_code = 'CURRENCY_MISMATCH' THEN NULL ELSE currency END
                                    ) STORED,
  wallet_player_id                  uuid GENERATED ALWAYS AS (
                                      CASE WHEN failure_code = 'WALLET_PLAYER_MISMATCH' THEN NULL ELSE player_id END
                                    ) STORED,
  reference_external_transaction_id text,
  reference_transaction_id          uuid,
  failure_code                      text,
  observed_balance                  numeric(20,2),
  attempts                          integer       NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz,
  locked_until                      timestamptz,
  created_at                        timestamptz   NOT NULL,
  updated_at                        timestamptz   NOT NULL,
  processed_at                      timestamptz,
  CONSTRAINT wager_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT wager_transactions_provider_idempotency_key_unique UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wager_transactions_provider_external_id_unique UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_transactions_id_wallet_unique UNIQUE (id, wallet_id),
  CONSTRAINT wager_transactions_id_wallet_status_unique UNIQUE (id, wallet_id, status),
  CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT wager_transactions_wallet_currency_fk FOREIGN KEY (wallet_id, wallet_currency)
    REFERENCES wallets (id, currency) MATCH SIMPLE,
  CONSTRAINT wager_transactions_wallet_player_fk FOREIGN KEY (wallet_id, wallet_player_id)
    REFERENCES wallets (id, player_id) MATCH SIMPLE,
  CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id, wallet_id)
    REFERENCES wager_transactions (id, wallet_id),
  CONSTRAINT wager_transactions_not_blank CHECK (
    btrim(provider_id) <> '' AND btrim(external_transaction_id) <> ''
    AND btrim(idempotency_key) <> '' AND btrim(payload_hash) <> ''
  ),
  CONSTRAINT wager_transactions_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  CONSTRAINT wager_transactions_status_valid CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_transactions_amount_by_kind CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  CONSTRAINT wager_transactions_round_and_game_required CHECK (
    kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)
  ),
  CONSTRAINT wager_transactions_reversal_requires_reference CHECK (
    kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
  ),
  CONSTRAINT wager_transactions_opening_without_reference CHECK (
    kind <> 'OPENING' OR (reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL)
  ),
  CONSTRAINT wager_transactions_reference_only_on_referencing_kinds CHECK (
    kind IN ('REFUND', 'ROLLBACK', 'WIN', 'LOSS')
    OR (reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL)
  ),
  CONSTRAINT wager_transactions_bet_never_pending CHECK (kind <> 'BET' OR status <> 'PENDING_REFERENCE'),
  CONSTRAINT wager_transactions_resolved_reference_requires_external CHECK (
    reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL
  ),
  CONSTRAINT wager_transactions_not_self_reference CHECK (reference_transaction_id <> id),
  CONSTRAINT wager_transactions_system_provider_only_for_opening CHECK ((kind = 'OPENING') = (provider_id = 'system')),
  CONSTRAINT wager_transactions_opening_shape CHECK (
    kind <> 'OPENING' OR (
      status = 'PROCESSED'
      AND idempotency_key = 'opening:' || wallet_id::text
      AND external_transaction_id = 'opening:' || wallet_id::text
    )
  ),
  CONSTRAINT wager_transactions_processed_has_processed_at CHECK (
    (status = 'PROCESSED') = (processed_at IS NOT NULL)
  ),
  CONSTRAINT wager_transactions_failure_code_by_status CHECK (
    (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
  ),
  CONSTRAINT wager_transactions_failure_code_valid CHECK (failure_code IN (
    'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_NOT_FOUND',
    'WALLET_PLAYER_MISMATCH', 'PROVIDER_IDENTITY_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH',
    'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED', 'ALREADY_REVERSED', 'AMOUNT_MISMATCH',
    'DUPLICATE_EXTERNAL_TRANSACTION', 'IDEMPOTENCY_CONFLICT'
  )),
  CONSTRAINT wager_transactions_processed_reversal_resolved CHECK (
    status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL
  ),
  CONSTRAINT wager_transactions_pending_reference_waits_for_reference CHECK (
    status <> 'PENDING_REFERENCE' OR (reference_external_transaction_id IS NOT NULL AND next_attempt_at IS NOT NULL)
  ),
  CONSTRAINT wager_transactions_observed_balance_on_outcome CHECK (
    status NOT IN ('PROCESSED', 'REJECTED') OR observed_balance IS NOT NULL
  ),
  CONSTRAINT wager_transactions_observed_balance_non_negative CHECK (observed_balance >= 0),
  CONSTRAINT wager_transactions_attempts_non_negative CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX wager_transactions_single_reversal_per_reference
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');

CREATE INDEX wager_transactions_pending_reference_due
  ON wager_transactions (next_attempt_at, id)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX wager_transactions_pending_by_reference
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX wager_transactions_reference ON wager_transactions (reference_transaction_id)
  WHERE reference_transaction_id IS NOT NULL;

CREATE INDEX wager_transactions_wallet_created ON wager_transactions (wallet_id, created_at);

CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager transactions are never deleted (transaction %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.round_id IS DISTINCT FROM OLD.round_id
     OR NEW.game_id IS DISTINCT FROM OLD.game_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable wager transaction columns cannot change (transaction %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
       OR NEW.reference_transaction_id IS DISTINCT FROM OLD.reference_transaction_id
       OR NEW.observed_balance IS DISTINCT FROM OLD.observed_balance
       OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.locked_until IS DISTINCT FROM OLD.locked_until
     ) THEN
    RAISE EXCEPTION 'wager transaction % is in terminal status % and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();

CREATE TRIGGER wager_transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TABLE wallet_ledger_entries (
  id              uuid          NOT NULL,
  seq             bigserial     NOT NULL,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(20,2) NOT NULL,
  currency        text          NOT NULL,
  balance_before  numeric(20,2) NOT NULL,
  balance_after   numeric(20,2) NOT NULL,
  wallet_version  integer       NOT NULL,
  created_at      timestamptz   NOT NULL,
  transaction_status text GENERATED ALWAYS AS ('PROCESSED') STORED,
  CONSTRAINT wallet_ledger_entries_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_ledger_entries_seq_unique UNIQUE (seq),
  CONSTRAINT wallet_ledger_entries_transaction_unique UNIQUE (transaction_id),
  CONSTRAINT wallet_ledger_entries_wallet_version_unique UNIQUE (wallet_id, wallet_version),
  CONSTRAINT wallet_ledger_entries_transaction_fk FOREIGN KEY (transaction_id, wallet_id, transaction_status)
    REFERENCES wager_transactions (id, wallet_id, status),
  CONSTRAINT wallet_ledger_entries_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
    REFERENCES wallets (id, currency),
  CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('CREDIT', 'DEBIT')),
  CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
  CONSTRAINT wallet_ledger_entries_before_non_negative CHECK (balance_before >= 0),
  CONSTRAINT wallet_ledger_entries_after_non_negative CHECK (balance_after >= 0),
  CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
    balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
  ),
  CONSTRAINT wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1)
);

CREATE INDEX wallet_ledger_entries_wallet_seq ON wallet_ledger_entries (wallet_id, seq);

CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are immutable (% on entry %)', TG_OP, OLD.id USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER wallet_ledger_entries_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable();

CREATE TRIGGER wallet_ledger_entries_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();
`;

const DOWN = /* sql */ `
DROP TABLE wallet_ledger_entries;
DROP FUNCTION wallet_ledger_entries_immutable();
DROP TABLE wager_transactions;
DROP FUNCTION wager_transactions_guard();
DROP TABLE wallets;
DROP FUNCTION reject_truncate();
DROP FUNCTION wallets_guard();
`;

export class Migration20261027000000WageringSchema extends Migration {
  override up(): void {
    this.addSql(UP);
  }

  override down(): void {
    this.addSql(DOWN);
  }
}
