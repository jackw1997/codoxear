import { fileIo as fs } from '@kit.CoreFileKit';

export interface DevicePreferences { server: string; family: string; mode: string; customCss?: string; }
export function readPreferences(directory: string): DevicePreferences {
  try { return JSON.parse(fs.readTextSync(directory + '/preferences.json')) as DevicePreferences; }
  catch (_) { return { server: '', family: 'clay', mode: 'system' }; }
}
export function writePreferences(directory: string, value: DevicePreferences): void {
  const path = directory + '/preferences.json';
  const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
  try { fs.writeSync(file.fd, JSON.stringify(value)); } finally { fs.closeSync(file); }
  fs.renameSync(path + '.tmp', path);
}

export interface LaunchChoice { server: string; backend: string; provider: string; model: string; }
export function readLaunchChoices(directory: string): LaunchChoice[] {
  try {
    const choices = JSON.parse(fs.readTextSync(directory + '/launch-choices.json')) as LaunchChoice[];
    return choices.filter((choice: LaunchChoice) => typeof choice.server === 'string' &&
      ['codex', 'pi', 'cc'].includes(choice.backend) && typeof choice.provider === 'string' && typeof choice.model === 'string');
  } catch (_) { return []; }
}
export function writeLaunchChoices(directory: string, choices: LaunchChoice[]): void {
  const path = directory + '/launch-choices.json';
  const file = fs.openSync(path + '.tmp', fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
  try { fs.writeSync(file.fd, JSON.stringify(choices)); } finally { fs.closeSync(file); }
  fs.renameSync(path + '.tmp', path);
}
export function rememberLaunch(choices: LaunchChoice[], next: LaunchChoice): LaunchChoice[] {
  return [next, ...choices.filter((choice: LaunchChoice) => choice.server !== next.server || choice.backend !== next.backend)].slice(0, 60);
}
