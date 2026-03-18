/**
 * Memory Database Schema & Initialization
 *
 * SQLite with WAL mode, FTS5 full-text search.
 * Uses better-sqlite3 for synchronous, high-performance access.
 */

import Database from 'better-sqlite3';

const SCHEMA_SQL = `
  -- Enable WAL mode for concurrent reads
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Core memories table
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    layer TEXT NOT NULL CHECK(layer IN ('fact', 'episode', 'reflection')),
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    embedding BLOB,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    user_id TEXT DEFAULT NULL
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
  CREATE INDEX IF NOT EXISTS idx_memories_access_count ON memories(access_count);
  CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

  -- FTS5 virtual table for full-text search on content
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid',
    tokenize='unicode61'
  );

  -- Triggers to keep FTS index in sync
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Timers table for persistence across restarts
  CREATE TABLE IF NOT EXISTS timers (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    message TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_timers_fire_at ON timers(fire_at);
  CREATE INDEX IF NOT EXISTS idx_timers_fired ON timers(fired);
`;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Execute schema in a transaction
  db.exec(SCHEMA_SQL);

  // Migrate: add columns that may not exist in older databases
  migrate(db);

  // Optimize for read-heavy workload
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');

  return db;
}

/** Add missing columns/tables for databases created by older versions. */
function migrate(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  const colNames = new Set(columns.map(c => c.name));

  if (!colNames.has('user_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN user_id TEXT DEFAULT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id)');
  }

  // Mission tables — created by MissionStore constructor via MISSION_SCHEMA_SQL,
  // but we also ensure they exist here for databases initialized before the mission module.
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
      context TEXT NOT NULL DEFAULT '',
      current_strategy TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      next_run_at INTEGER NOT NULL DEFAULT 0,
      run_interval_ms INTEGER NOT NULL DEFAULT 1800000,
      methodology TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_missions_next_run_at ON missions(next_run_at);

    CREATE TABLE IF NOT EXISTS mission_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      learning TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mission_steps_mission_id ON mission_steps(mission_id);
    CREATE INDEX IF NOT EXISTS idx_mission_steps_timestamp ON mission_steps(timestamp);
  `);

  // Migrate missions table: add source_channel and source_reply_to for notification routing
  const missionCols = db.prepare("PRAGMA table_info(missions)").all() as { name: string }[];
  const missionColNames = new Set(missionCols.map(c => c.name));

  if (!missionColNames.has('source_channel')) {
    db.exec("ALTER TABLE missions ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'terminal'");
  }
  if (!missionColNames.has('source_reply_to')) {
    db.exec("ALTER TABLE missions ADD COLUMN source_reply_to TEXT NOT NULL DEFAULT 'user'");
  }
}
