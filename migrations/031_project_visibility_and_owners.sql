-- Add project visibility (private by default for new projects; existing projects
-- backfilled to public) and cache public owner profile fields on esphub.accounts.

ALTER TABLE esphub.accounts
  ADD COLUMN display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  ADD COLUMN avatar_url text CHECK (avatar_url IS NULL OR (avatar_url LIKE 'https://%' AND char_length(avatar_url) <= 512)),
  ADD COLUMN email text CHECK (email IS NULL OR char_length(email) <= 320),
  ADD COLUMN profile_synced_at timestamptz;

ALTER TABLE esphub.projects
  ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));

UPDATE esphub.projects SET visibility = 'public';

CREATE INDEX projects_public_idx
  ON esphub.projects (updated_at DESC, id)
  WHERE visibility = 'public' AND NOT archived;
