-- The Hub now reads source links and release files only from the firmware publisher's
-- records. Refuse to deploy it until the publisher has backfilled every current row.
DO $$
DECLARE
  missing bigint;
  first text;
BEGIN
  SELECT count(*), min(r.board || ' ' || r.kind) INTO missing, first
  FROM esphub.firmware_releases r
  WHERE r.tag IS NULL OR NOT EXISTS (
    SELECT 1 FROM esphub.release_assets a
    WHERE a.tag = r.tag AND a.board = r.board AND a.kind = r.kind);
  IF missing > 0 THEN
    RAISE EXCEPTION '% latest firmware releases have no indexed files, first %', missing, first;
  END IF;

  SELECT count(*), min(id) INTO missing, first FROM esphub.boards
  WHERE published_examples IS NULL OR bootloader_source_url IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '% boards have no published source links, first %', missing, first;
  END IF;

  SELECT count(*), min(revision) INTO missing, first FROM esphub.board_sources
  WHERE sdk_source_url IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '% board sources have no SDK source link, first %', missing, first;
  END IF;
END $$;

ALTER TABLE esphub.firmware_releases ALTER COLUMN tag SET NOT NULL;
ALTER TABLE esphub.boards
  ALTER COLUMN published_examples SET NOT NULL,
  ALTER COLUMN bootloader_source_url SET NOT NULL;
ALTER TABLE esphub.board_sources ALTER COLUMN sdk_source_url SET NOT NULL;
