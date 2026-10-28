import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Migrações em ordem. `PRAGMA user_version` guarda quantas já foram aplicadas (decisão D-003). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sectors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    inactivity_minutes INTEGER NOT NULL DEFAULT 30,
    queue_timeout_min INTEGER,
    welcome_message TEXT,
    closing_message TEXT,
    business_hours TEXT
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN','SUPERVISOR','AGENT')),
    sector_id TEXT REFERENCES sectors(id),
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    wa_id TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    sector_id TEXT REFERENCES sectors(id),
    assigned_user_id TEXT REFERENCES users(id),
    origin TEXT NOT NULL CHECK (origin IN ('CUSTOMER','AGENT')),
    status TEXT NOT NULL CHECK (status IN ('BOT','QUEUED','HUMAN','CLOSED')),
    failed_ai_attempts INTEGER NOT NULL DEFAULT 0,
    menu_count INTEGER NOT NULL DEFAULT 0,
    ever_human INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    last_interaction_at TEXT NOT NULL,
    warned_at TEXT,
    first_response_at TEXT,
    human_started_at TEXT,
    closed_at TEXT,
    close_reason TEXT CHECK (close_reason IN ('RESOLVED_AI','RESOLVED_AGENT','INACTIVITY','MANUAL')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_conv_sector_status ON conversations(sector_id, status);
  CREATE INDEX idx_conv_status_last ON conversations(status, last_interaction_at);
  -- no máximo uma conversa aberta por contato, mesmo com mensagens simultâneas
  CREATE UNIQUE INDEX uq_conv_open_per_contact ON conversations(contact_id) WHERE status != 'CLOSED';

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('CUSTOMER','AI','AGENT','SYSTEM')),
    sender_user_id TEXT REFERENCES users(id),
    body TEXT NOT NULL,
    sent_body TEXT,
    media_path TEXT,
    media_type TEXT,
    wa_message_id TEXT UNIQUE,
    ack INTEGER NOT NULL DEFAULT 0,
    send_status TEXT NOT NULL DEFAULT 'SENT' CHECK (send_status IN ('PENDING','SENT','FAILED')),
    ai_meta TEXT,
    feedback INTEGER CHECK (feedback IN (1,-1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_msg_conv ON messages(conversation_id, created_at);

  CREATE TABLE knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    sector_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','READY','FAILED')),
    error TEXT,
    source TEXT,
    file_path TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE quick_replies (
    id TEXT PRIMARY KEY,
    sector_id TEXT REFERENCES sectors(id),
    shortcut TEXT NOT NULL,
    body TEXT NOT NULL
  );

  CREATE TABLE style_examples (
    id TEXT PRIMARY KEY,
    sector_id TEXT REFERENCES sectors(id),
    context TEXT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    approved INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    dedupe_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_jobs_due ON jobs(status, run_at);
  CREATE UNIQUE INDEX uq_jobs_pending_key ON jobs(dedupe_key) WHERE status = 'PENDING' AND dedupe_key IS NOT NULL;

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const applied = db.pragma('user_version', { simple: true }) as number;
    if (applied > MIGRATIONS.length) {
      throw new Error(`O banco é mais novo (v${applied}) que esta versão do app (v${MIGRATIONS.length}).`);
    }
    for (let v = applied; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]!);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
    return db;
  } catch (err) {
    db.close(); // não deixa o arquivo preso (Windows)
    throw err;
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
