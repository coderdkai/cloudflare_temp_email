-- 2026-09-21 patch: Add mail_logs table for audit & debug
CREATE TABLE IF NOT EXISTS mail_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    source TEXT,
    address TEXT,
    subject TEXT,
    action TEXT,
    forwarded_to TEXT,
    fingerprint TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_logs_address ON mail_logs(address);
CREATE INDEX IF NOT EXISTS idx_mail_logs_created_at ON mail_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_mail_logs_action ON mail_logs(action);
