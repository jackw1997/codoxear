import { Session, TokenUsage } from './Contracts';

export interface SessionDiagnostics extends Session {
  thread_id?: string;
  log_path?: string;
  codex_pid?: number;
  tmux_session?: string;
  tmux_window?: string;
  broker_busy?: boolean;
  time_priority?: number;
  base_priority?: number;
  final_priority?: number;
}
export interface DetailRow { label: string; value: string; }
export function sessionDiagnostics(raw: string): SessionDiagnostics | undefined {
  try {
    const value = JSON.parse(raw) as SessionDiagnostics;
    return value && typeof value.session_id === 'string' ? value : undefined;
  } catch (_) { return undefined; }
}
function row(label: string, value: string | number | boolean | null | undefined): DetailRow {
  return { label: label, value: value === undefined || value === null || value === '' ? 'Not available' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : '' + value };
}
export function sessionOverview(s: SessionDiagnostics): DetailRow[] {
  return [row('Backend', s.agent_backend === 'cc' ? 'Claude Code' : s.agent_backend === 'codex' ? 'Codex' : s.agent_backend === 'pi' ? 'Pi' : s.agent_backend),
    row('Provider', s.provider_choice || s.model_provider), row('Status', s.lost ? 'Disconnected' : s.busy ? 'Working' : 'Idle'),
    row('Queued messages', s.queue_len || 0), row('Working directory', s.cwd), row('Git branch', s.git_branch)];
}
export function contextDetails(token: TokenUsage | null | undefined): DetailRow[] {
  if (!token) return [];
  return [row('Tokens in context', token.tokens_in_context?.toLocaleString()), row('Context window', token.context_window?.toLocaleString()),
    row('Remaining', typeof token.percent_remaining === 'number' ? token.percent_remaining + '%' : undefined),
    row('Reserved tokens', token.reserved_tokens?.toLocaleString())];
}
export function technicalDetails(s: SessionDiagnostics): DetailRow[] {
  return [row('Session ID', s.session_id), row('Thread ID', s.thread_id), row('Log path', s.log_path),
    row('Broker process', s.broker_pid), row('Agent process', s.codex_pid), row('Transport', s.transport || (s.owned ? 'App' : 'Terminal')),
    row('Tmux session', s.tmux_session), row('Tmux window', s.tmux_window), row('Authentication', s.preferred_auth_method),
    row('Service tier', s.service_tier || 'Standard'), row('Started', s.start_ts ? new Date(s.start_ts * 1000).toLocaleString() : undefined),
    row('Updated', s.updated_ts ? new Date(s.updated_ts * 1000).toLocaleString() : undefined), row('Priority adjustment', s.priority_offset),
    row('Time priority', s.time_priority), row('Base priority', s.base_priority), row('Final priority', s.final_priority),
    row('Dependency', s.dependency_session_id || 'None'), row('Snoozed until', s.snooze_until ? new Date(s.snooze_until * 1000).toLocaleString() : 'Not snoozed')];
}
