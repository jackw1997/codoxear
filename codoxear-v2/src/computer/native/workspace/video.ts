import { execFile } from "node:child_process";
import { mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openFile } from "./files.js";
import { DomainError } from "../../../contracts/model.js";
const pending = new Map<string, Promise<string>>();
export async function videoPreview(
  path: string,
  home: string,
  signal: AbortSignal,
) {
  const input = await openFile(path);
  try {
    const info = await input.stat();
    if (!info.isFile())
      throw new DomainError(400, "not_video", "path is not a video");
    const cache = join(home, "video-previews");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(`${path}:${info.size}:${info.mtimeMs}`)
      .digest("hex");
    const output = join(cache, key + ".mp4");
    try {
      if ((await stat(output)).size > 0) return output;
    } catch {}
    const prior = pending.get(output);
    if (prior) return await prior;
    const operation = (async () => {
      const temp = join(cache, key + "." + randomUUID() + ".mp4");
      try {
        await new Promise<void>((yes, no) =>
          execFile(
            process.env.FFMPEG_BIN ?? "ffmpeg",
            [
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-i",
              `/proc/${process.pid}/fd/${input.fd}`,
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-movflags",
              "+faststart",
              temp,
            ],
            { signal, timeout: 120000, maxBuffer: 1024 * 1024 },
            (error) =>
              error
                ? no(
                    new DomainError(
                      503,
                      "video_preview_failed",
                      "Video preview requires working ffmpeg on this Computer; download the original video",
                    ),
                  )
                : yes(),
          ),
        );
        await rename(temp, output);
        return output;
      } finally {
        await unlink(temp).catch(() => {});
      }
    })();
    pending.set(output, operation);
    try {
      return await operation;
    } finally {
      pending.delete(output);
    }
  } finally {
    await input.close();
  }
}
