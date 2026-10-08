import { Session, LaunchCatalog, SlashCommand } from './Contracts';
export interface ComposerChoice { title: string; description: string; kind: string; value: string; }
export function supports(session: Session, kind: string): boolean {
  const backend = session.agent_backend;
  if (backend === 'cc') return true;
  if (backend === 'pi') return kind === 'model' || session.pi_thinking_command === true;
  return backend === 'codex' && !!session.slash_commands?.some((command: SlashCommand) => command.name === kind);
}
export function composerChoices(session: Session | undefined, catalog: LaunchCatalog, draft: string): ComposerChoice[] {
  if (!session || !draft.startsWith('/') || draft.includes('\n')) return [];
  const match = /^\/(model|effort|thinking)\s+(.*)$/i.exec(draft);
  const defaults = catalog.backends[session.agent_backend || ''] || {};
  if (match) {
    const kind = match[1].toLowerCase() === 'thinking' ? 'effort' : match[1].toLowerCase();
    if (!supports(session, kind)) return [];
    let values: string[] = [];
    if (kind === 'effort') {
      const key = session.agent_backend === 'pi' && session.model_provider ? session.model_provider + '/' + session.model : session.model || '';
      values = defaults.reasoning_efforts_by_model?.[key] || defaults.reasoning_efforts_by_model?.[session.model || ''] || defaults.reasoning_efforts || [];
    } else if (session.agent_backend === 'pi' && defaults.provider_models) {
      Object.keys(defaults.provider_models).forEach((provider: string) => {
        (defaults.provider_models?.[provider] || []).forEach((model: string) => { values.push(provider + '/' + model); });
      });
    } else {
      const provider = session.provider_choice || (session.model_provider === 'openai' ? (session.preferred_auth_method === 'chatgpt' ? 'chatgpt' : 'openai-api') : session.model_provider || '');
      values = defaults.provider_models?.[provider] || defaults.models || [];
    }
    if (kind === 'model' && session.model && !values.includes(session.model)) values = [session.model].concat(values);
    const filter = match[2].toLowerCase();
    return values.filter((value: string) => value.toLowerCase().includes(filter)).slice(0, 30)
      .map((value: string): ComposerChoice => { return { title: value, description: '', kind: kind, value: value }; });
  }
  if (/\s/.test(draft)) return [];
  const commands: SlashCommand[] = (session.slash_commands || []).slice();
  ['model', 'effort'].forEach((kind: string) => {
    if (supports(session, kind) && !commands.some((command: SlashCommand) => command.name === kind)) commands.push({ name: kind, description: kind === 'model' ? 'Select model' : 'Set reasoning effort' });
  });
  return commands.filter((command: SlashCommand) => (command.name || '').startsWith(draft.slice(1).toLowerCase())).slice(0, 30)
    .map((command: SlashCommand): ComposerChoice => { return { title: '/' + command.name, description: command.description || '', kind: 'command', value: command.name || '' }; });
}
