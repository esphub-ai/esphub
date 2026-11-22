CREATE UNIQUE INDEX access_tokens_developer_owner
ON esphub.access_tokens(owner) WHERE kind = 'developer';
