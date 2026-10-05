import { openFile } from "./files.js";
import { DomainError } from "../../../contracts/model.js";
export async function dimensions(path: string) {
  const file = await openFile(path);
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const b = bytes.subarray(0, bytesRead);
    let width = 0,
      height = 0;
    if (
      b.length >= 24 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      width = b.readUInt32BE(16);
      height = b.readUInt32BE(20);
    } else if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
      width = b.readUInt16LE(6);
      height = b.readUInt16LE(8);
    } else if (
      b.length >= 30 &&
      b.toString("ascii", 8, 12) === "WEBP" &&
      b.toString("ascii", 12, 16) === "VP8X"
    ) {
      width = 1 + b.readUIntLE(24, 3);
      height = 1 + b.readUIntLE(27, 3);
    } else if (b[0] === 255 && b[1] === 216) {
      let off = 2;
      while (off + 9 < b.length) {
        if (b[off] !== 255) {
          off++;
          continue;
        }
        const marker = b[off + 1]!;
        if (
          [
            192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
          ].includes(marker)
        ) {
          height = b.readUInt16BE(off + 5);
          width = b.readUInt16BE(off + 7);
          break;
        }
        const size = b.readUInt16BE(off + 2);
        if (size < 2) break;
        off += size + 2;
      }
    }
    if (!width || !height)
      throw new DomainError(
        400,
        "image_dimensions",
        "Image dimensions could not be determined",
      );
    return { ok: true, width, height };
  } finally {
    await file.close();
  }
}
