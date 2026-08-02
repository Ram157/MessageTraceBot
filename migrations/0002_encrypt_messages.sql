ALTER TABLE messages
ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_encryption_version
  ON messages(encryption_version);
