PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS business_connections (
  connection_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  owner_chat_id INTEGER NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_policies (
  connection_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  auto_delete_seconds INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, chat_id)
);

CREATE TABLE IF NOT EXISTS messages (
  connection_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  incoming INTEGER NOT NULL DEFAULT 1,
  sender_id INTEGER,
  sender_name TEXT NOT NULL,
  chat_title TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  edited_at INTEGER,
  text TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  media_type TEXT,
  media_file_id TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  report_sent INTEGER NOT NULL DEFAULT 0,
  media_sent INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_active
  ON messages(connection_id, incoming, archived);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_time
  ON processed_updates(processed_at);
