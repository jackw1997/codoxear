import { DomainError } from "../../../contracts/model.js";
const PREFIX = "codoxear-git-path-bytes-v1:";
export function rawPath(bytes: Buffer) {
  let text = "";
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i]!;
    let count =
      first < 128
        ? 1
        : first >= 194 && first <= 223
          ? 2
          : first >= 224 && first <= 239
            ? 3
            : first >= 240 && first <= 244
              ? 4
              : 0;
    if (count && i + count <= bytes.length) {
      const part = bytes.subarray(i, i + count);
      try {
        text += new TextDecoder("utf-8", { fatal: true }).decode(part);
        i += count;
        continue;
      } catch {}
    }
    text += String.fromCharCode(0xdc00 + first);
    i++;
  }
  return text;
}
export function pathBytes(text: string) {
  const chunks: Buffer[] = [];
  for (const character of text) {
    const cp = character.codePointAt(0)!;
    chunks.push(
      cp >= 0xdc80 && cp <= 0xdcff
        ? Buffer.from([cp - 0xdc00])
        : Buffer.from(character),
    );
  }
  return Buffer.concat(chunks);
}
export function displayPath(path: string) {
  return path.replace(
    /[\udc80-\udcff]/gu,
    (c) => "\\x" + (c.charCodeAt(0) - 0xdc00).toString(16).padStart(2, "0"),
  );
}
export function pathFields(path: string) {
  return {
    path: displayPath(path),
    ...(/[\udc80-\udcff]/u.test(path)
      ? {
          api_path: PREFIX + pathBytes(path).toString("base64url"),
          non_utf8_path: true,
        }
      : {}),
  };
}
export function decodePathToken(token: string) {
  if (!token.startsWith(PREFIX))
    throw new DomainError(400, "invalid_path", "Invalid path token");
  const value = token.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new DomainError(400, "invalid_path", "Invalid path token");
  const raw = Buffer.from(value, "base64url");
  if (raw.includes(0) || raw.toString("base64url") !== value)
    throw new DomainError(400, "invalid_path", "Invalid path token");
  return rawPath(raw);
}
export function mediaQuery(path: string) {
  const fields = pathFields(path);
  return (
    "?path=" +
    encodeURIComponent(fields.path) +
    (fields.api_path
      ? "&path_token=" + encodeURIComponent(fields.api_path)
      : "")
  );
}
