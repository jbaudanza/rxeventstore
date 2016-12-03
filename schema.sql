DROP TABLE events;

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  actor JSONB,
  timestamp TIMESTAMP,
  ip_address INET,
  key TEXT,
  process_id UUID,
  session_id UUID,
  connection_id INTEGER,
  aggregate_root TEXT,
  data JSONB NOT NULL
);
