import { nativePush } from './NativePush';
import { media } from '@kit.MediaKit';
import { notificationManager } from '@kit.NotificationKit';
import { common, wantAgent } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { ApiClient } from './ApiClient';

export interface VoiceSettings {
  tts_base_url: string;
  tts_enabled_for_narration: boolean;
  tts_enabled_for_final_response: boolean;
  has_tts_api_key: boolean;
}
export interface VoiceWrite {
  tts_base_url: string; tts_api_key: string; tts_api_key_clear: boolean;
  tts_enabled_for_narration: boolean; tts_enabled_for_final_response: boolean;
}
export interface PromptSettings { prompt: string; default_prompt: string; }
interface FeedItem { message_id: string; session_id: string; session_display_name: string; notification_text: string; updated_ts: number; }
interface Feed { items: FeedItem[]; }
@Observed
export class Announcements {
  settings: VoiceSettings = { tts_base_url: '', tts_enabled_for_narration: false, tts_enabled_for_final_response: true, has_tts_api_key: false };
  prompt: string = '';
  defaultPrompt: string = '';
  listening: boolean = false;
  notifications: boolean = false;
  notificationRegistration: boolean = false;
  private backgroundNotifications: boolean = false;
  status: string = '';
  audioStatus: string = '';
  private audioGeneration: number = 0;
  private notificationGeneration: number = 0;
  private audioWork: Promise<void> = Promise.resolve();
  private player: media.AVPlayer | undefined = undefined;
  private timer: number = -1;
  private generation: number = 0;
  private since: number = 0;
  private seen: Set<string> = new Set();
  private polling: boolean = false;
  private clientId: string = 'harmony-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  private notificationId: number = 1;

  async load(api: ApiClient): Promise<void> {
    this.notificationRegistration = nativePush.hasRegistration();
    const generation = this.generation;
    const voice = JSON.parse(await api.request('/api/settings/voice')) as VoiceSettings;
    if (generation !== this.generation) return;
    const prompt = JSON.parse(await api.request('/api/settings/unattended-prompt')) as PromptSettings;
    if (generation !== this.generation) return;
    this.settings = voice; this.prompt = prompt.prompt; this.defaultPrompt = prompt.default_prompt;
  }
  async save(api: ApiClient, settings: VoiceWrite, prompt: string): Promise<void> {
    const generation = this.generation;
    const voice = JSON.parse(await api.request('/api/settings/voice', http.RequestMethod.POST, JSON.stringify(settings))) as VoiceSettings;
    if (generation !== this.generation) return;
    const saved = JSON.parse(await api.request('/api/settings/unattended-prompt', http.RequestMethod.POST, JSON.stringify({ prompt: prompt } as PromptSettings))) as PromptSettings;
    if (generation !== this.generation) return;
    this.settings = voice; this.prompt = saved.prompt; this.defaultPrompt = saved.default_prompt; this.status = 'Saved';
  }
  private startPolling(api: ApiClient): void {
    if (this.timer !== -1) return;
    this.timer = setInterval(() => { this.poll(api); }, 5000);
  }
  async setNotifications(api: ApiClient, enabled: boolean, context: common.UIAbilityContext): Promise<void> {
    const generation = ++this.notificationGeneration;
    if (!enabled) { try { await nativePush.disable(api); } finally { this.notificationRegistration = nativePush.hasRegistration(); } if (generation !== this.notificationGeneration) return; this.notifications = false; this.backgroundNotifications = false; this.status = 'Notifications disabled'; this.stopUnusedTimer(); return; }
    await notificationManager.requestEnableNotification(context);
    if (generation !== this.notificationGeneration) return;
    const data = JSON.parse(await api.request('/api/notifications/feed?since=0')) as Feed;
    if (generation !== this.notificationGeneration) return;
    (data.items || []).forEach((item: FeedItem) => { this.seen.add(item.message_id); this.since = Math.max(this.since, item.updated_ts); });
    let background = false;
    try { background = await nativePush.enable(api, (message: string) => { if (generation === this.notificationGeneration) this.status = message; }); }
    finally { this.notificationRegistration = nativePush.hasRegistration(); }
    if (generation !== this.notificationGeneration) return;
    this.backgroundNotifications = background; this.notifications = true; this.startPolling(api);
  }
  setListening(api: ApiClient, enabled: boolean): Promise<void> {
    const generation = ++this.audioGeneration;
    this.listening = enabled;
    this.audioStatus = enabled ? 'Connecting audio…' : '';
    const work = this.audioWork.catch(() => {}).then(async () => {
      if (generation !== this.audioGeneration) return;
      const previous = this.player; this.player = undefined;
      try {
        if (previous) await previous.release();
        await api.request('/api/audio/listener', http.RequestMethod.POST, JSON.stringify({ client_id: this.clientId, enabled: enabled }));
        if (generation !== this.audioGeneration) return;
        if (!enabled) { this.stopUnusedTimer(); return; }
        const player = await media.createAVPlayer();
        if (generation !== this.audioGeneration) { await player.release(); return; }
        this.player = player;
        player.on('stateChange', (state: string) => {
          if (generation !== this.audioGeneration) return;
          if (state === 'initialized') player.prepare().catch((reason: Error) => { this.audioFailed(api, generation, reason); });
          if (state === 'prepared') player.play().catch((reason: Error) => { this.audioFailed(api, generation, reason); });
          if (state === 'playing') this.audioStatus = 'Listening';
        });
        player.on('error', (reason: Error) => { this.audioFailed(api, generation, reason); });
        await player.setMediaSource(media.createMediaSourceWithUrl(api.address('/api/audio/live.m3u8'), api.authHeaders()));
        if (generation === this.audioGeneration) this.startPolling(api);
      } catch (reason) {
        if (generation === this.audioGeneration) {
          this.listening = false; this.audioStatus = 'Audio: ' + (reason as Error).message;
          const failed = this.player; this.player = undefined;
          if (failed) await failed.release().catch(() => {});
          this.stopUnusedTimer();
          await api.request('/api/audio/listener', http.RequestMethod.POST, JSON.stringify({ client_id: this.clientId, enabled: false })).catch(() => {});
        }
        throw new Error((reason as Error).message);
      }
    });
    this.audioWork = work;
    return work;
  }
  private audioFailed(api: ApiClient, generation: number, reason: Error): void {
    if (generation !== this.audioGeneration) return;
    this.setListening(api, false).catch(() => {});
    this.audioStatus = 'Audio: ' + reason.message;
  }
  private stopUnusedTimer(): void {
    if (!this.listening && !this.notifications && this.timer !== -1) { clearInterval(this.timer); this.timer = -1; }
  }
  private async poll(api: ApiClient): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      if (this.listening) {
        const audioGeneration = this.audioGeneration;
        const heartbeat = this.audioWork.catch(() => {}).then(async () => {
          if (audioGeneration === this.audioGeneration && this.listening) {
            await api.request('/api/audio/listener', http.RequestMethod.POST, JSON.stringify({ client_id: this.clientId, enabled: true }));
          }
        });
        this.audioWork = heartbeat;
        await heartbeat;
      }
      if (this.notifications && !this.backgroundNotifications) {
        const data = JSON.parse(await api.request('/api/notifications/feed?since=' + Math.max(0, this.since - 1))) as Feed;
        for (const item of data.items || []) {
          if (generation !== this.generation || !this.notifications) return;
          if (!this.seen.has(item.message_id)) {
            const id = this.notificationId++;
            const tap = await wantAgent.getWantAgent({ wants: [{ bundleName: 'com.codoxear.mobile', abilityName: 'EntryAbility',
              parameters: { 'codoxear.session': item.session_id, 'codoxear.server': api.notificationScope() } }],
              operationType: wantAgent.OperationType.START_ABILITY, requestCode: id,
              wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG] });
            if (generation !== this.generation || !this.notifications) return;
            await notificationManager.publish({ id: id, wantAgent: tap, content: { notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
              normal: { title: item.session_display_name, text: item.notification_text } } });
            this.seen.add(item.message_id);
          }
          this.since = Math.max(this.since, item.updated_ts);
        }
      }
    } catch (reason) { if (generation === this.generation) this.status = (reason as Error).message; }
    finally { this.polling = false; }
  }
  dispose(api: ApiClient): void {
    this.generation++; this.notificationGeneration++; this.notifications = false; this.backgroundNotifications = false; nativePush.detach();
    this.setListening(api, false).catch(() => {});
    this.stopUnusedTimer();
    this.seen.clear(); this.since = 0;
  }
}
