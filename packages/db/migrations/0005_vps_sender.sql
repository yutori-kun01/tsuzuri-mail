-- VPS 上の送信ワーカー（キューを使わず DB から送信待ちを拾う）のための再試行間隔
ALTER TABLE messages ADD COLUMN last_attempt_at timestamptz;
CREATE INDEX messages_sendable_idx ON messages (queued_at) WHERE status = 'queued';
