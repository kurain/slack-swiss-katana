-- polls: アンケート本体
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT,
  creator_id TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0,              -- 1 なら匿名投票
  results_visibility TEXT NOT NULL DEFAULT 'realtime', -- 'realtime' | 'hidden'
  status TEXT NOT NULL DEFAULT 'open',                -- 'open' | 'closed'
  created_at TEXT NOT NULL,
  closed_at TEXT
);

-- options: 選択肢
CREATE TABLE IF NOT EXISTS options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id, position);

-- votes: 投票。(poll_id, voter_key) が主キーなので同一ユーザーは 1 票のみ。
-- voter_key は匿名投票では HMAC でハッシュ化した値、通常投票では Slack のユーザーID。
CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL REFERENCES polls(id),
  voter_key TEXT NOT NULL,
  option_id TEXT NOT NULL REFERENCES options(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, voter_key)
);
CREATE INDEX IF NOT EXISTS idx_votes_option ON votes(option_id);
