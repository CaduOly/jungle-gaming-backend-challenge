import { Migration } from '@mikro-orm/migrations';

const UP_SQL = `
CREATE OR REPLACE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager transactions are never deleted (transaction %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
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
  END IF;

  IF NEW.reference_transaction_id IS NOT NULL THEN
    SELECT status, kind, provider_id, external_transaction_id
      INTO ref_row
      FROM wager_transactions
      WHERE id = NEW.reference_transaction_id;
    IF FOUND THEN
      IF ref_row.provider_id IS DISTINCT FROM NEW.provider_id
         OR ref_row.external_transaction_id IS DISTINCT FROM NEW.reference_external_transaction_id THEN
        RAISE EXCEPTION 'reference_external_transaction_id does not match referenced transaction'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'PROCESSED' AND NEW.kind = 'REFUND'
         AND (ref_row.status <> 'PROCESSED' OR ref_row.kind <> 'BET') THEN
        RAISE EXCEPTION 'PROCESSED REFUND must reference a PROCESSED BET (got % %)', ref_row.status, ref_row.kind
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'PROCESSED' AND NEW.kind = 'ROLLBACK'
         AND (ref_row.status <> 'PROCESSED' OR ref_row.kind NOT IN ('BET', 'WIN', 'REFUND')) THEN
        RAISE EXCEPTION 'PROCESSED ROLLBACK must reference a PROCESSED BET, WIN or REFUND (got % %)', ref_row.status, ref_row.kind
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER wager_transactions_guard ON wager_transactions;
CREATE TRIGGER wager_transactions_guard BEFORE INSERT OR UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();
`;

const DOWN_SQL = `
DROP TRIGGER wager_transactions_guard ON wager_transactions;

CREATE OR REPLACE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
`;

export class Migration20261029000000ReferenceSchemaGuards extends Migration {
  override async up(): Promise<void> {
    this.addSql(UP_SQL);
  }

  override async down(): Promise<void> {
    this.addSql(DOWN_SQL);
  }
}
