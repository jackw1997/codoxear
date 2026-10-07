import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { DomainError } from "../contracts/model.js";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};
export async function workspaceAsset(
  root: string,
  path: string,
  context: {
    issuer: string;
    accountId: string;
    hubId: string;
    computerId: string;
    scopeId?: string;
  },
) {
  let relative: string;
  try {
    relative = decodeURIComponent(path);
  } catch {
    throw new DomainError(400, "invalid_path", "Invalid asset path");
  }
  if (
    relative.includes("\\") ||
    relative.includes("%") ||
    relative.split("/").some((p) => p === "." || p === "..")
  )
    throw new DomainError(400, "invalid_path", "Invalid asset path");
  if (relative.startsWith("static/")) relative = relative.slice(7);
  relative = relative || "index.html";
  const base = resolve(root),
    file = resolve(base, relative);
  if (!file.startsWith(base + sep))
    throw new DomainError(403, "invalid_path", "Invalid asset path");
  let body: Buffer;
  try {
    const [actualBase, actualFile] = await Promise.all([
      realpath(base),
      realpath(file),
    ]);
    if (!actualFile.startsWith(actualBase + sep))
      throw new DomainError(403, "invalid_path", "Invalid asset path");
    body = await readFile(actualFile);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(404, "not_found", "Workspace asset not found");
  }
  if (relative === "index.html") {
    const data = JSON.stringify(context).replaceAll("<", "\\u003c");
    body = Buffer.from(
      body
        .toString("utf8")
        .replace(
          "<head>",
          '<head><script type="application/json" id="codoxear-connection-context">' +
            data +
            "</script>",
        ),
    );
  }
  return { type: mime[extname(file)] ?? "application/octet-stream", body };
}
