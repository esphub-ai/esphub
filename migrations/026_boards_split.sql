-- Split pure hardware board definitions (owned by esphub-boards) from legacy
-- example catalog metadata (still published by esphub-firmware).

DROP VIEW esphub.board_profiles;

-- 1. Move legacy example metadata into esphub.board_examples.
CREATE TABLE esphub.board_examples (
  board text PRIMARY KEY CHECK (board ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$'),
  source_revision text NOT NULL REFERENCES esphub.board_sources(revision),
  default_example text NOT NULL,
  published_examples jsonb NOT NULL CHECK (jsonb_typeof(published_examples) = 'array'),
  bootloader_source_url text NOT NULL CHECK (bootloader_source_url LIKE 'https://%')
);

INSERT INTO esphub.board_examples
  (board, source_revision, default_example, published_examples, bootloader_source_url)
SELECT id, source_revision, default_example, published_examples, bootloader_source_url
FROM esphub.boards;

-- 2. Replace esphub.boards with the pure structured hardware table.
ALTER TABLE esphub.boards RENAME TO boards_legacy;

CREATE TABLE esphub.boards (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$'),
  vendor        text NOT NULL CHECK (vendor ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND id LIKE vendor || '/%'),
  name          text NOT NULL,
  model         text NOT NULL,
  soc           text NOT NULL CHECK (soc ~ '^esp32[a-z0-9]*$'),
  flash_mb      integer NOT NULL CHECK (flash_mb >= 8),
  flash_bus     text NOT NULL DEFAULT 'quad' CHECK (flash_bus IN ('quad', 'octal')),
  psram         text CHECK (psram IN ('quad', 'octal')),
  console       text NOT NULL CHECK (console IN ('usb-serial-jtag', 'uart')),
  bootloader    text NOT NULL CHECK (bootloader ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  product_url   text CHECK (product_url LIKE 'https://%'),
  has_photo     boolean NOT NULL DEFAULT false,
  preview       boolean NOT NULL DEFAULT false,
  retired       boolean NOT NULL DEFAULT false,
  display_order integer,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Backfill all existing boards and product links for zero-downtime cutover.
-- The first esphub-boards sync fills in psram and reconciles has_photo.
INSERT INTO esphub.boards (
  id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
  bootloader, product_url, has_photo, preview, retired, display_order
)
SELECT
  b.id,
  split_part(b.id, '/', 1),
  b.name,
  b.model,
  b.chip,
  b.flash_mb,
  CASE WHEN COALESCE(b.bootloader, '') LIKE '%-opi' THEN 'octal' ELSE 'quad' END,
  NULL,
  CASE
    WHEN COALESCE(b.bootloader, '') LIKE '%-uart' OR b.chip IN ('esp32', 'esp32s31')
    THEN 'uart'
    ELSE 'usb-serial-jtag'
  END,
  COALESCE(b.bootloader, b.chip || '-' || b.flash_mb || 'mb'),
  p.product_url,
  b.id <> 'lilygo/t-embed-plus-v2',
  b.preview,
  NOT s.is_current,
  b.display_order
FROM esphub.boards_legacy b
JOIN esphub.board_sources s ON s.revision = b.source_revision
LEFT JOIN esphub.board_product_pages p ON p.board = b.id;

DROP TABLE esphub.boards_legacy;
DROP TABLE esphub.board_product_pages;

-- 3. Rebuild board_profiles from esphub.boards LEFT JOIN legacy example tables.
CREATE VIEW esphub.board_profiles AS
  SELECT
    b.id,
    b.vendor,
    b.name,
    b.model,
    b.soc,
    b.flash_mb,
    b.flash_bus,
    b.psram,
    b.console,
    b.bootloader,
    b.product_url,
    b.has_photo,
    b.preview,
    b.retired,
    b.display_order,
    b.updated_at,
    e.source_revision,
    e.default_example,
    e.published_examples,
    e.bootloader_source_url,
    s.sdk_version,
    s.sdk_source_url,
    COALESCE(s.is_current, false) AS is_current
  FROM esphub.boards b
  LEFT JOIN esphub.board_examples e ON e.board = b.id
  LEFT JOIN esphub.board_sources s ON s.revision = e.source_revision;

-- 4. Restore runtime grants and separate boards vs firmware publisher privileges.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT ON esphub.boards, esphub.board_examples, esphub.board_profiles TO esphub_runtime;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_boards_publisher') THEN
    GRANT USAGE ON SCHEMA esphub TO esphub_boards_publisher;
    GRANT SELECT, INSERT, UPDATE ON esphub.boards TO esphub_boards_publisher;
  END IF;
END $$;

DO $$
DECLARE publisher name;
BEGIN
  FOR publisher IN
    SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'esphub' AND table_name = 'firmware_releases'
      AND privilege_type IN ('INSERT', 'UPDATE') AND grantee NOT IN ('PUBLIC', current_user)
    GROUP BY grantee HAVING count(DISTINCT privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON esphub.board_examples TO %I', publisher);
    EXECUTE format('REVOKE ALL ON esphub.boards FROM %I', publisher);
  END LOOP;
END $$;
