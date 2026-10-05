import { fileIo as fs, fileUri } from '@kit.CoreFileKit';

export interface AttachmentFile { name: string; bytes: Uint8Array; }

// Provider reads can return fewer bytes than requested. Keep reading without
// blocking the UI, and reject a truncated source rather than padding it with NULs.
export async function readAttachment(uri: string, current: () => boolean): Promise<AttachmentFile> {
  const file = await fs.open(uri, fs.OpenMode.READ_ONLY);
  try {
    const size = (await fs.stat(file.fd)).size;
    if (size > 16 * 1024 * 1024) throw new Error('Attachment exceeds 16 MB.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (!current()) throw new Error('Attachment selection changed. Select the file again.');
      const chunk = new ArrayBuffer(Math.min(65536, size - offset));
      const count = await fs.read(file.fd, chunk);
      if (count <= 0) throw new Error('The file changed while being read. Select it again.');
      bytes.set(new Uint8Array(chunk, 0, count), offset);
      offset += count;
    }
    let name = 'attachment';
    try { name = new fileUri.FileUri(uri).name || name; }
    catch (_) { try { name = decodeURIComponent(uri.split('/').pop() || name); } catch (_) {} }
    return { name: name, bytes: bytes };
  } finally { await fs.close(file); }
}
