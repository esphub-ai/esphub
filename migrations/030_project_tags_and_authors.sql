-- Add project authors directory and project tags (e.g. "example", "factory").

CREATE TABLE esphub.authors (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(id) <= 64),
  name       text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  logo_url   text CHECK (logo_url LIKE 'https://%' AND char_length(logo_url) <= 512),
  url        text CHECK (url LIKE 'https://%' AND char_length(url) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO esphub.authors (id, name, logo_url, url) VALUES
  ('esphub', 'EspHub', 'https://esphub.ai/authors/esphub.svg', 'https://esphub.ai'),
  ('m5stack', 'M5Stack', 'https://esphub.ai/authors/m5stack.svg', 'https://m5stack.com'),
  ('espressif', 'Espressif', 'https://esphub.ai/authors/espressif.svg', 'https://www.espressif.com'),
  ('lilygo', 'LILYGO', 'https://esphub.ai/authors/lilygo.webp', 'https://lilygo.cc'),
  ('adafruit', 'Adafruit', 'https://esphub.ai/authors/adafruit.svg', 'https://www.adafruit.com'),
  ('seeed-studio', 'Seeed Studio', 'https://esphub.ai/authors/seeed-studio.webp', 'https://www.seeedstudio.com'),
  ('waveshare', 'Waveshare', 'https://esphub.ai/authors/waveshare.webp', 'https://www.waveshare.com')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE esphub.projects
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  ADD COLUMN author_id text REFERENCES esphub.authors(id),
  ADD COLUMN upstream_url text CHECK (upstream_url LIKE 'https://%' AND char_length(upstream_url) <= 1024);

CREATE INDEX projects_tags_idx ON esphub.projects USING GIN (tags);
CREATE INDEX projects_author_idx ON esphub.projects (author_id) WHERE author_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT ON esphub.authors TO esphub_runtime;
  END IF;
END $$;
