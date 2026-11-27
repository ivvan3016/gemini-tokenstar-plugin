export type TokenMode = 'total' | 'non_cache';

export type CelestialType = 'star' | 'black_hole' | 'binary' | 'pulsar' | 'comet';

export type SourceType = 'antigravity' | 'gemini_cli';

export interface ModelBreakdownItem {
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  steps: number;
}

export interface SubagentSummary {
  id: string;
  role: string;
  type_name: string;
  primary_model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  non_cache_tokens: number;
  last_status: string;
}

export interface RequestStar {
  id: string;
  conversation_id: string;
  session_id: string;
  step_index: number;
  turn_index: number;
  created_at: string;
  local_date: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  non_cache_tokens: number;
  tool_calls_count: number;
  subagent_calls_count: number;
  status: string;
  is_subagent: boolean;
  subagent_role: string;
  celestial_type: CelestialType;
  celestial_reason: string;
}

export interface ConversationStar {
  id: string;
  source: SourceType;
  title: string;
  started_at: string;
  ended_at: string;
  local_date: string;
  primary_model: string;
  models: ModelBreakdownItem[];
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  non_cache_tokens: number;
  user_turns: number;
  model_steps_count: number;
  tool_calls_count: number;
  subagent_calls_count: number;
  subagents: SubagentSummary[];
  requests?: RequestStar[];
  is_orphan_subagent: boolean;
  error_steps_count: number;
  last_status: string;
  celestial_type: CelestialType;
  celestial_reason: string;
}

export interface SourceScanReport {
  source: SourceType;
  directory: string;
  exists: boolean;
  scanned_files: number;
  parsed_conversations: number;
  skipped_files: number;
  warnings: string[];
}

export interface SkyDataResponse {
  schema_version: '1.0';
  generated_at: string;
  scan_duration_ms: number;
  sources: SourceScanReport[];
  conversations: ConversationStar[];
}

export interface StarFilterState {
  query: string;
  models: string[];
  celestialTypes: CelestialType[];
  date: string | null;
}

export interface UpdateCheckResult {
  status: 'ok' | 'error';
  current_version: string;
  latest_version: string | null;
  tag_name: string | null;
  has_update: boolean;
  can_self_update: boolean;
  has_bundle_asset: boolean;
  release_url: string;
  published_at: string | null;
  release_notes: string;
  error: string | null;
}

export interface UpdateApplyResult {
  status: 'updated';
  previous_version: string;
  updated_version: string;
  backend_changed: boolean;
  restart_required: boolean;
  sync_deferred: boolean;
  message: string;
}
