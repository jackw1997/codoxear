import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { WorkspaceRuntime } from "../../runtime.js";
import { readSettings, updateSettings } from "./settings.js";
import { DomainError } from "../../../contracts/model.js";
const DEFAULTS = {
  tts_enabled_for_narration: false,
  tts_enabled_for_final_response: true,
  tts_base_url: "https://api.openai.com/v1",
  tts_api_key: "",
  summarization_model: "gpt-4o-mini",
  tts_model: "gpt-4o-mini-tts",
};
export class NativeVoice {
  private sequence = 0;
  private listenerEpoch = 0;
  private clips: Array<{ name: string; duration: number }> = [];
  private listeners = new Map<string, number>();
  private seen = new Set<string>();
  private timer: NodeJS.Timeout;
  private active = false;
  private since = Date.now();
  private error: string | null = null;
  private abort = new AbortController();
  private listenerAbort = new AbortController();
  constructor(private runtime: WorkspaceRuntime) {
    this.timer = setInterval(() => void this.poll().catch(() => {}), 1000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.abort.abort();
    this.listenerAbort.abort();
  }
  private cancelListenerWork() {
    this.listenerEpoch++;
    this.listenerAbort.abort();
    this.listenerAbort = new AbortController();
  }
  private get directory() {
    return join(this.runtime.stateHome, "audio");
  }
  private saved() {
    return readSettings(this.runtime.stateHome);
  }
  async snapshot() {
    const state = await this.saved();
    const settings = { ...DEFAULTS, ...(state.voice as object) };
    this.pruneListeners();
    return {
      ok: true,
      ...settings,
      tts_api_key: "",
      has_tts_api_key: !!settings.tts_api_key,
      audio: {
        queue_depth: this.active ? 1 : 0,
        active_listener_count: this.listeners.size,
        stream_url: "/api/audio/live.m3u8",
        segment_count: this.clips.length,
        last_error: this.error,
      },
      notifications: { enabled: false, supported: false },
    };
  }
  async settings(body: Record<string, unknown>) {
    await updateSettings(this.runtime.stateHome, (state) => {
      const previous = { ...DEFAULTS, ...(state.voice as object) };
      const next = {
        ...previous,
        ...Object.fromEntries(
          Object.keys(DEFAULTS)
            .filter((key) => key in body)
            .map((key) => [key, body[key]]),
        ),
        tts_api_key:
          body.tts_api_key_clear === true
            ? ""
            : typeof body.tts_api_key === "string" && body.tts_api_key
              ? body.tts_api_key
              : previous.tts_api_key,
      };
      if (
        typeof next.tts_base_url !== "string" ||
        !/^https?:\/\//.test(next.tts_base_url)
      )
        throw new DomainError(
          400,
          "invalid_tts_url",
          "Enter a valid TTS API URL",
        );
      for (const key of ["tts_model", "summarization_model"])
        if (typeof (next as Record<string, unknown>)[key] !== "string")
          throw new DomainError(
            400,
            "invalid_voice_setting",
            key + " must be a string",
          );
      for (const key of [
        "tts_enabled_for_narration",
        "tts_enabled_for_final_response",
      ])
        if (typeof (next as Record<string, unknown>)[key] !== "boolean")
          throw new DomainError(
            400,
            "invalid_voice_setting",
            key + " must be a boolean",
          );
      delete (next as Record<string, unknown>).tts_api_key_clear;
      state.voice = next;
    });
    const current = { ...DEFAULTS, ...((await this.saved()).voice as object) };
    if (
      !current.tts_api_key ||
      (!current.tts_enabled_for_final_response &&
        !current.tts_enabled_for_narration)
    )
      this.cancelListenerWork();
    return this.snapshot();
  }
  listener(body: Record<string, unknown>) {
    if (
      typeof body.client_id !== "string" ||
      !body.client_id.trim() ||
      body.client_id.length > 200
    )
      throw new DomainError(400, "listener_required", "client_id required");
    this.pruneListeners();
    const previous = this.listeners.size,
      id = body.client_id.trim();
    if (body.enabled === false) this.listeners.delete(id);
    else this.listeners.set(id, Date.now() + 45000);
    if (previous === 0 && this.listeners.size > 0) {
      this.since = Date.now();
      this.cancelListenerWork();
      this.clips = [];
      this.sequence = 0;
    }
    if (previous > 0 && this.listeners.size === 0) this.cancelListenerWork();
    return { ok: true, active_listener_count: this.listeners.size };
  }
  private pruneListeners() {
    const previous = this.listeners.size;
    for (const [id, until] of this.listeners)
      if (until < Date.now()) this.listeners.delete(id);
    if (previous && !this.listeners.size) this.cancelListenerWork();
  }

  playlist() {
    let content =
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:" +
      Math.max(4, ...this.clips.map((c) => Math.ceil(c.duration))) +
      "\n#EXT-X-MEDIA-SEQUENCE:" +
      this.sequence +
      "\n";
    for (const clip of this.clips)
      content +=
        "#EXT-X-DISCONTINUITY\n#EXTINF:" +
        clip.duration.toFixed(3) +
        ",\n/api/audio/segments/" +
        clip.name +
        "\n";
    return Buffer.from(content);
  }
  segmentPath(name: string) {
    if (!/^[a-f0-9-]+-\d+\.ts$/.test(name))
      throw new DomainError(400, "invalid_segment", "Invalid audio segment");
    return join(this.directory, name);
  }
  private async poll() {
    if (this.active || this.abort.signal.aborted) return;
    this.pruneListeners();
    if (!this.listeners.size) return;
    const state = await this.saved(),
      settings = { ...DEFAULTS, ...(state.voice as object) };
    if (
      !settings.tts_api_key ||
      (!settings.tts_enabled_for_final_response &&
        !settings.tts_enabled_for_narration)
    )
      return;
    const catalogue = (await this.runtime.request("/api/sessions")) as {
      sessions: Array<{ session_id: string; alias?: string; cwd?: string }>;
    };
    this.active = true;
    const epoch = this.listenerEpoch,
      since = this.since,
      signal = this.listenerAbort.signal;
    try {
      for (const session of catalogue.sessions.slice(0, 64)) {
        const transcript = (await this.runtime.request(
          `/api/sessions/${session.session_id}/messages/tail?limit=100`,
        )) as {
          events?: Array<{
            role: string;
            text: string;
            ts: number;
            message_id: string;
            message_class?: string;
          }>;
        };
        const candidates = (transcript.events ?? []).filter(
          (event) =>
            event.role === "assistant" &&
            event.text &&
            event.ts * 1000 >= since &&
            !this.seen.has(session.session_id + event.message_id) &&
            ((event.message_class === "narration" &&
              settings.tts_enabled_for_narration) ||
              (event.message_class === "final_response" &&
                settings.tts_enabled_for_final_response)),
        );
        const final = candidates
            .filter((event) => event.message_class === "final_response")
            .at(-1),
          narration = candidates
            .filter((event) => event.message_class === "narration")
            .at(-1);
        const selected = final ? [final] : narration ? [narration] : [];
        for (const event of candidates) {
          this.seen.add(session.session_id + event.message_id);
          this.since = Math.max(this.since, event.ts * 1000);
        }
        for (const event of selected) {
          if (this.listenerEpoch !== epoch || !this.listeners.size) return;
          try {
            const maxWords = event.message_class === "narration" ? 15 : 30;
            let input = event.text.replace(/\s+/g, " ").trim();
            if (input.split(/\s+/).length >= maxWords)
              input = await this.summarize(input, settings, maxWords, signal);
            if (this.listenerEpoch !== epoch || !this.listeners.size) return;
            await this.synthesize(
              `From ${session.alias || "the agent"}. ${input}`,
              settings,
              epoch,
              signal,
            );
          } catch {
            if (signal.aborted) return;
            this.error =
              "Voice synthesis failed; check the configured TTS provider and ffmpeg.";
          }
        }
      }
    } finally {
      this.active = false;
    }
  }
  private async summarize(
    input: string,
    settings: typeof DEFAULTS,
    maxWords: number,
    signal: AbortSignal,
  ) {
    const response = await fetch(
      settings.tts_base_url.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + settings.tts_api_key,
        },
        body: JSON.stringify({
          model: settings.summarization_model,
          temperature: 0,
          max_completion_tokens: maxWords === 15 ? 48 : 72,
          messages: [
            {
              role: "system",
              content: `Compress this assistant ${maxWords === 15 ? "progress narration" : "final response"} into one plain spoken sentence of at most ${maxWords} words. Report only concrete facts from the source. Omit hashes, long identifiers, verbatim file paths, filler, markdown and prefixes.`,
            },
            { role: "user", content: input.slice(0, 16000) },
          ],
        }),
        signal: AbortSignal.any([
          this.abort.signal,
          signal,
          AbortSignal.timeout(60000),
        ]),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Summary failed");
    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = result.choices?.[0]?.message?.content
      ?.replace(/\s+/g, " ")
      .trim();
    if (!summary || summary.split(/\s+/).length > maxWords)
      throw new Error("Invalid summary");
    return summary;
  }
  private async synthesize(
    input: string,
    settings: typeof DEFAULTS,
    epoch: number,
    signal: AbortSignal,
  ) {
    const url = new URL(
      settings.tts_base_url.replace(/\/$/, "") + "/audio/speech",
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + settings.tts_api_key,
      },
      body: JSON.stringify({
        model: settings.tts_model,
        input,
        voice: "alloy",
        response_format: "wav",
      }),
      signal: AbortSignal.any([
        this.abort.signal,
        signal,
        AbortSignal.timeout(60000),
      ]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("TTS failed");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 64 * 1024 * 1024) throw new Error("Audio too large");
    const audio = Buffer.from(await response.arrayBuffer());
    if (this.listenerEpoch !== epoch || !this.listeners.size) return;
    if (audio.length > 64 * 1024 * 1024) throw new Error("Audio too large");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(),
      source = join(this.directory, id + ".wav"),
      playlist = join(this.directory, id + ".m3u8");
    await writeFile(source, audio, { flag: "wx", mode: 0o600 });
    let published = false;
    try {
      await new Promise<void>((yes, no) =>
        execFile(
          process.env.FFMPEG_BIN ?? "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-i",
            source,
            "-vn",
            "-c:a",
            "aac",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_list_size",
            "0",
            "-hls_segment_filename",
            join(this.directory, id + "-%04d.ts"),
            playlist,
          ],
          {
            timeout: 120000,
            signal: AbortSignal.any([this.abort.signal, signal]),
            maxBuffer: 1024 * 1024,
          },
          (error) => (error ? no(error) : yes()),
        ),
      );
      const generated = await readFile(playlist, "utf8");
      if (this.listenerEpoch !== epoch || !this.listeners.size) return;
      const rows = generated.split("\n");
      for (let n = 0; n < rows.length; n++)
        if (rows[n]!.startsWith("#EXTINF:")) {
          const duration = Number(rows[n]!.slice(8).split(",")[0]);
          const name = rows[n + 1]!.split("/").at(-1)!;
          this.clips.push({ name, duration });
        }
      while (this.clips.length > 128) {
        const removed = this.clips.shift()!;
        this.sequence++;
        await unlink(join(this.directory, removed.name)).catch(() => {});
      }
      this.error = null;
      published = true;
    } finally {
      await unlink(source).catch(() => {});
      await unlink(playlist).catch(() => {});
      if (!published)
        for (const name of await readdir(this.directory).catch(() => []))
          if (name.startsWith(id + "-"))
            await unlink(join(this.directory, name)).catch(() => {});
    }
  }
}
