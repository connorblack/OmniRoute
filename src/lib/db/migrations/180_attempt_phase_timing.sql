ALTER TABLE call_logs ADD COLUMN upstream_headers_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN request_to_headers_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN first_upstream_byte_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN first_useful_event_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN first_content_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN terminal_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN ttft_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN outcome_source TEXT;
ALTER TABLE call_logs ADD COLUMN upstream_status INTEGER;
ALTER TABLE call_logs ADD COLUMN upstream_request_id TEXT;
ALTER TABLE call_logs ADD COLUMN upstream_lifecycle_status TEXT;

ALTER TABLE usage_history ADD COLUMN upstream_headers_ms INTEGER;
ALTER TABLE usage_history ADD COLUMN request_to_headers_ms INTEGER;
ALTER TABLE usage_history ADD COLUMN outcome_source TEXT;
ALTER TABLE usage_history ADD COLUMN upstream_status INTEGER;
ALTER TABLE usage_history ADD COLUMN upstream_request_id TEXT;
ALTER TABLE usage_history ADD COLUMN upstream_lifecycle_status TEXT;

CREATE INDEX IF NOT EXISTS idx_cl_provider_connection_model_time
  ON call_logs(provider, connection_id, model, timestamp DESC);
