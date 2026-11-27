-- Add multi-board projects, preview images, immutable per-board app releases,
-- and latest release pointers owned by personal EspHub accounts.

CREATE TABLE esphub.projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       uuid NOT NULL REFERENCES esphub.accounts(id),
  name        text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  repo_url    text CHECK (repo_url LIKE 'https://%' AND char_length(repo_url) <= 512),
  repo_path   text CHECK (
    char_length(repo_path) <= 512
    AND repo_path ~ '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$'
    AND repo_path !~ '(^|/)\.\.?(/|$)'
  ),
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (repo_path IS NULL OR repo_url IS NOT NULL)
);
CREATE INDEX projects_owner_idx ON esphub.projects (owner);

CREATE TABLE esphub.project_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES esphub.projects(id) ON DELETE CASCADE,
  position     integer NOT NULL CHECK (position >= 0),
  is_cover     boolean NOT NULL DEFAULT false,
  object_key   text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/webp', 'image/png', 'image/jpeg')),
  size         integer NOT NULL CHECK (size > 0 AND size <= 5242880),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  upload_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, position),
  UNIQUE (project_id, sha256)
);
CREATE UNIQUE INDEX project_images_cover_idx
  ON esphub.project_images (project_id) WHERE is_cover;

CREATE TABLE esphub.project_releases (
  project_id      uuid NOT NULL REFERENCES esphub.projects(id),
  board_id        text NOT NULL REFERENCES esphub.boards(id),
  version         text NOT NULL CHECK (
    version ~ '^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|[0-9a-f]{7,40})$'
  ),
  app_key         text NOT NULL,
  app_size        integer NOT NULL CHECK (app_size > 0),
  app_sha256      text NOT NULL CHECK (app_sha256 ~ '^[0-9a-f]{64}$'),
  app_elf_sha256  text CHECK (app_elf_sha256 ~ '^[0-9a-f]{64}$'),
  app_upload_id   uuid NOT NULL,
  sdk_version     text NOT NULL CHECK (btrim(sdk_version) <> '' AND char_length(sdk_version) <= 64),
  idf_version     text CHECK (idf_version IS NULL OR (btrim(idf_version) <> '' AND char_length(idf_version) <= 64)),
  source_revision text CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, board_id, version)
);
CREATE INDEX project_releases_elf_sha256_idx
  ON esphub.project_releases (app_elf_sha256) WHERE app_elf_sha256 IS NOT NULL;

CREATE TABLE esphub.project_boards (
  project_id     uuid NOT NULL REFERENCES esphub.projects(id),
  board_id       text NOT NULL REFERENCES esphub.boards(id),
  latest_version text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, board_id),
  FOREIGN KEY (project_id, board_id, latest_version)
    REFERENCES esphub.project_releases (project_id, board_id, version)
);
CREATE INDEX project_boards_board_idx ON esphub.project_boards (board_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON esphub.projects, esphub.project_images, esphub.project_boards TO esphub_runtime;
    GRANT SELECT, INSERT ON esphub.project_releases TO esphub_runtime;
  END IF;
END $$;
