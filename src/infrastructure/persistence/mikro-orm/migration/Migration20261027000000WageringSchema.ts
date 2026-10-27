import { Migration } from '@mikro-orm/migrations';

/*
 * Wallets, wager transactions and the immutable ledger. Every invariant from README §5.9/§6 lives here,
 * so it holds even if application code is wrong or several instances race.
 *
 * Trigger violations raise SQLSTATE 23001 (restrict_violation) so the application can classify them as
 * permanent integrity errors.
 *
 * OPENING (wallet opened with balance > 0) is stored as a regular wager transaction so the ledger always
 * has a transaction_id and the composite FKs close:
 *   provider_id             = 'system' (reserved: only OPENING may use it, OPENING may only use it)
 *   external_transaction_id = idempotency_key = 'opening:<walletId>'  -> at most one OPENING per wallet
 *   status                  = 'PROCESSED', no reference, round_id/game_id may be NULL.
 *
 * CURRENCY_MISMATCH rejections must be persisted (replay returns 422) but their currency differs from the
 * wallet's, which would break FK (wallet_id, currency). `wallet_currency` is a generated column that is NULL
 * only for that rejection; the composite FK uses MATCH SIMPLE and is skipped there, while wallet_id keeps its
 * own FK. For every other row the FK forces currency = wallet currency.
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
  CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency)
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
  CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT wager_transactions_wallet_currency_fk FOREIGN KEY (wallet_id, wallet_currency)
    REFERENCES wallets (id, currency) MATCH SIMPLE,
  CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id)
    REFERENCES wager_transactions (id),
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
  CONSTRAINT wager_transactions_failure_code_format CHECK (failure_code ~ '^[A-Z][A-Z_]*$'),
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

CREATE FUNCTION reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

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
  CONSTRAINT wallet_ledger_entries_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_ledger_entries_seq_unique UNIQUE (seq),
  CONSTRAINT wallet_ledger_entries_transaction_unique UNIQUE (transaction_id),
  CONSTRAINT wallet_ledger_entries_wallet_version_unique UNIQUE (wallet_id, wallet_version),
  CONSTRAINT wallet_ledger_entries_transaction_fk FOREIGN KEY (transaction_id, wallet_id)
    REFERENCES wager_transactions (id, wallet_id),
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
DROP FUNCTION reject_truncate();
DROP TABLE wallets;
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
