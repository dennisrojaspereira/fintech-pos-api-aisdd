-- Migration 20260501_initial_constraints_and_indexes
--
-- Complementa a migration gerada pelo `prisma migrate` com:
--   1. CHECK constraints (amount > 0, currency ISO 4217)
--   2. Índice parcial em transactions(status='PENDING') para o background poll
--   3. REVOKE DELETE/UPDATE em audit_entries para garantir append-only (req 8.3)
--
-- Pré-requisito: a migration "init" gerada por `prisma migrate dev` já criou
-- as tabelas e os índices declarados no schema.prisma.
--
-- Para rodar manualmente em ambientes pré-existentes:
--   psql "$DATABASE_URL" -f migration.sql

-- ────────────────────────────────────────────────
-- 1. CHECK constraints em transactions
-- ────────────────────────────────────────────────

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_amount_positive
  CHECK (amount > 0);

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_currency_iso4217
  CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_masked_pan_format
  CHECK (masked_pan ~ '^\*{4,}\d{4}$');

-- O CHECK no enum status já é garantido pela coluna ser do tipo enum
-- TransactionStatus declarado pelo Prisma. O design.md menciona o CHECK
-- explicitamente — ficar com o enum nativo cumpre a invariante.

-- ────────────────────────────────────────────────
-- 2. Partial index em PENDING (Task 2.2 / req 2.3)
-- ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tx_status_pending_partial
  ON transactions (id, last_acquirer_check_at)
  WHERE status = 'PENDING';

-- ────────────────────────────────────────────────
-- 3. Append-only audit_entries (req 8.3, 8.4)
-- ────────────────────────────────────────────────

-- Cria o role da API se ainda não existir. Em produção este passo deve ser
-- gerenciado pelo time de plataforma; aqui está como referência idempotente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_user') THEN
    CREATE ROLE api_user NOLOGIN;
  END IF;
END
$$;

-- Concede apenas SELECT + INSERT em audit_entries.
REVOKE ALL    ON audit_entries FROM api_user;
GRANT  SELECT ON audit_entries TO   api_user;
GRANT  INSERT ON audit_entries TO   api_user;
-- Explicitamente NÃO concede UPDATE/DELETE/TRUNCATE.

-- ────────────────────────────────────────────────
-- 4. Marker para o histórico de migrations do Prisma reconhecer
-- ────────────────────────────────────────────────
-- (Quando aplicada via `prisma migrate dev`, o nome do diretório acima já
--  identifica a migration no _prisma_migrations.)
