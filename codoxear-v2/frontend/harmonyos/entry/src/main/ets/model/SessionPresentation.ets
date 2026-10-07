import { Session, CreateSession } from './Contracts';

export function launchPending(session: Session): boolean {
  const state = (session.launch_state || '').trim().toLowerCase();
  return !!state && state !== 'failed';
}
export function launchFailed(session: Session): boolean { return !!session.lost || (session.launch_state || '').trim().toLowerCase() === 'failed'; }
export function sessionBadges(session: Session): string[] {
  const badges: string[] = [];
  if (launchFailed(session)) badges.push(session.lost ? 'lost' : 'failed');
  if (launchPending(session)) badges.push('starting');
  if (session.unattended_enabled) badges.push('unattended');
  if (session.queue_len) badges.push('queue ' + session.queue_len);
  if ((session.unread_count || 0) > 0) badges.push('unread ' + session.unread_count);
  return badges;
}
export function sessionGroup(session: Session): number { return session.blocked ? 1 : session.snoozed ? 2 : 0; }
export function tomorrowMorning(now: number = Date.now()): number {
  const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}
export function duplicateRequest(session: Session): CreateSession {
  if (!session.cwd || session.cwd === '?') throw new Error('Working directory unavailable.');
  if (launchFailed(session) || launchPending(session)) throw new Error('Review this session before starting another.');
  return { cwd: session.cwd, agent_backend: session.agent_backend || 'codex', model: session.model || 'default',
    model_provider: session.model_provider || '', preferred_auth_method: session.preferred_auth_method || '',
    service_tier: session.service_tier === 'fast' ? 'fast' : '', reasoning_effort: session.reasoning_effort || 'high',
    resume_session_id: '', worktree_branch: '', create_in_tmux: session.transport === 'tmux' };
}

export function customSnooze(dateText: string, timeText: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^\d{2}:\d{2}$/.test(timeText)) throw new Error('Choose a valid snooze date and time.');
  const parts = dateText.split('-').map((value: string) => Number(value));
  const clock = timeText.split(':').map((value: string) => Number(value));
  const date = new Date(parts[0], parts[1] - 1, parts[2], clock[0], clock[1], 0, 0);
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2] || date.getHours() !== clock[0] || date.getMinutes() !== clock[1]) throw new Error('Choose a valid snooze date and time.');
  return Math.floor(date.getTime() / 1000);
}

export function sessionBackend(session: Session): string {
  return ['pi', 'cc'].includes(session.agent_backend || '') ? session.agent_backend! : 'codex';
}
export function sessionLaunchIcon(session: Session): string {
  return launchFailed(session) ? 'info' : session.transport === 'tmux' ? 'tmux' : session.owned ? 'web' : 'terminal';
}
export function sessionEffort(session: Session): string {
  const names = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const codes = ['off', 'min', 'low', 'med', 'hi', 'xh', 'max'];
  const code = codes[names.indexOf((session.reasoning_effort || '').trim().toLowerCase())] || '';
  return code && session.agent_backend === 'cc' ? code + '*' : code;
}
export function sessionModel(session: Session): string {
  const model = (session.model || '').trim();
  if (!model || model.toLowerCase() === 'default') return '';
  if (model.length <= 16) return model;
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1) {
    const name = model.slice(slash + 1);
    if (name.length <= 8) return model.slice(0, Math.max(1, 16 - name.length - 2)) + '…/' + name;
  }
  return model.slice(0, 6) + '…' + model.slice(-8);
}
export function sessionAge(session: Session, now: number = Date.now()): string {
  if (session.lost) return 'lost';
  if (launchPending(session)) return 'starting';
  const timestamp = Number.isFinite(session.updated_ts) ? session.updated_ts! : session.start_ts || 0;
  const age = timestamp ? Math.max(0, now / 1000 - timestamp) : 0;
  return age < 60 ? 'just now' : age < 3600 ? Math.floor(age / 60) + 'm ago' : age < 86400 ? Math.floor(age / 3600) + 'h ago' : Math.floor(age / 86400) + 'd ago';
}
export function sessionMetadata(session: Session, now: number = Date.now()): string {
  const model = sessionModel(session), effort = sessionEffort(session);
  const folder = (session.cwd || '').split('/').filter((part: string) => !!part).pop() || '';
  return [sessionAge(session, now), model + (effort ? ' ·' + effort : ''), folder, (session.git_branch || '').trim()].filter((part: string) => !!part).join(' | ');
}

// Only presentation changes replace a native row. Poll-only priority/telemetry
// fields must not destroy its active swipe gesture or keyboard hint target.
export function sessionCardKey(session: Session, now: number = Date.now()): string {
  return JSON.stringify([session.session_id, session.alias, session.first_user_message,
    sessionBackend(session), sessionLaunchIcon(session), sessionMetadata(session, now),
    session.service_tier, session.busy, session.blocked, session.snoozed,
    session.subagents_running, sessionBadges(session)]);
}
