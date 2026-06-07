-- Add the 'purchase' transaction type (cosmetic shop bought with wallet balance).
-- PG12+ allows ADD VALUE inside the migration transaction; the value is only USED at runtime.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'purchase';
