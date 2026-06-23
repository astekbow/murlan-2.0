-- Add the player-to-player transfer transaction types (balance sent/received between friends).
-- PG12+ allows ADD VALUE inside the migration transaction; the value is only USED at runtime
-- (same pattern as 20260607000000_transaction_purchase).
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'transfer_out';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'transfer_in';
