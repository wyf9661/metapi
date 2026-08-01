CREATE TABLE IF NOT EXISTS probe_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  question_category TEXT NOT NULL,
  question_text TEXT NOT NULL,
  response_text TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  tokens_used INTEGER,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS probe_logs_created_at_idx ON probe_logs(created_at);
CREATE INDEX IF NOT EXISTS probe_logs_site_created_at_idx ON probe_logs(site_id, created_at);
CREATE INDEX IF NOT EXISTS probe_logs_account_created_at_idx ON probe_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS probe_logs_model_created_at_idx ON probe_logs(model_name, created_at);
CREATE INDEX IF NOT EXISTS probe_logs_status_created_at_idx ON probe_logs(status, created_at);
