export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE forges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('github','gitea','git')),
    name TEXT NOT NULL,
    base_url TEXT,
    webhook_secret TEXT,
    created_at TEXT NOT NULL
  );

  -- An account on a forge: its token (write-only), what its check found, and who its commits are by.
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    forge_id TEXT NOT NULL REFERENCES forges(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    username TEXT,
    token TEXT,
    token_set_at TEXT,
    auth_json TEXT,
    commit_name TEXT,
    commit_email TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT '',
    settings_json TEXT NOT NULL DEFAULT '{}',
    credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL
  );

  CREATE TABLE repos (
    key TEXT PRIMARY KEY,
    forge_id TEXT NOT NULL REFERENCES forges(id),
    group_id TEXT NOT NULL REFERENCES groups(id),
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    line TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    policy TEXT NOT NULL DEFAULT '',
    settings_json TEXT NOT NULL DEFAULT '{}',
    credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
    last_fetch_at TEXT,
    last_head TEXT,
    fetch_error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE rounds (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    check_kind TEXT NOT NULL,
    check_revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('round','author','confirm')),
    scope TEXT NOT NULL CHECK (scope IN ('diff','full')),
    base_sha TEXT,
    head_sha TEXT NOT NULL,
    proposal_id TEXT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    report TEXT,
    error TEXT,
    usage_json TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX rounds_repo ON rounds(repo_key, check_kind, started_at);

  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    check_kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    category TEXT NOT NULL,
    anchor TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'minor',
    sensitive INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    first_round TEXT NOT NULL,
    last_round TEXT NOT NULL,
    proposal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repo_key, check_kind, fingerprint)
  );

  CREATE TABLE dismissals (
    finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    by TEXT NOT NULL,
    at TEXT NOT NULL
  );

  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    check_kind TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT,
    state TEXT NOT NULL,
    delivery TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    finding_ids TEXT NOT NULL,
    summary TEXT,
    patch TEXT,
    validation TEXT,
    submitted_ref TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    repo_key TEXT,
    ref_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE overrides (
    id TEXT PRIMARY KEY,
    activity_id TEXT,
    proposed TEXT NOT NULL,
    decided TEXT NOT NULL,
    reason TEXT,
    at TEXT NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    code TEXT NOT NULL,
    repo_key TEXT,
    message TEXT NOT NULL,
    detail TEXT
  );

  CREATE TABLE queue (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL CHECK (job IN ('round','author')),
    repo_key TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    check_kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    base_sha TEXT,
    head_sha TEXT,
    foreground INTEGER NOT NULL DEFAULT 0,
    tier INTEGER NOT NULL DEFAULT 5,
    trigger TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    started_at TEXT
  );

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    round_id TEXT,
    agent INTEGER NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    wall_ms INTEGER
  );

  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool TEXT,
    pending TEXT,
    at TEXT NOT NULL
  );
  `,
  // A proposal for this finding failed or was refused against this input: do not try again
  // until the input changes (Touchstone's task memory, applied to findings).
  `ALTER TABLE findings ADD COLUMN blocked_input TEXT;`,
  // Ready and auto-submitting, held back by the hourly delivery cap: the tick delivers it later.
  `ALTER TABLE proposals ADD COLUMN auto_waiting INTEGER NOT NULL DEFAULT 0;`,
]
