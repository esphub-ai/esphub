-- Remove the unused board preview flag from esphub.boards.

ALTER TABLE esphub.boards DROP COLUMN IF EXISTS preview;
