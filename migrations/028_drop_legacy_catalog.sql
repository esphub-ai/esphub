-- Drop the legacy board_profiles compatibility view and firmware-publisher tables.
-- Boards now live solely in esphub.boards, bootloaders in esphub.bootloaders and
-- esphub.bootloader_releases, and apps in esphub.projects / project_releases / project_boards.

DROP VIEW esphub.board_profiles;
DROP TABLE esphub.board_examples;
DROP TABLE esphub.board_sources;
DROP TABLE esphub.release_assets;
DROP TABLE esphub.firmware_releases;
