import { common } from '@kit.AbilityKit';
import { request } from '@kit.BasicServicesKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { ApiClient } from './ApiClient';

// Stream through the system download service, then copy to the user-selected URI.
// File bytes are never buffered in the ArkUI process.
export async function exportFile(context: common.UIAbilityContext, api: ApiClient, path: string, name: string): Promise<boolean> {
  const version = api.connectionVersion();
  api.requireConnection(version);
  const address = api.address(path);
  const headers = api.authHeaders();
  const destinations = await new picker.DocumentViewPicker(context).save({ newFileNames: [name] });
  if (!destinations.length) return false;
  api.requireConnection(version);
  const temporary = context.cacheDir + '/export-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  let task: request.DownloadTask | undefined = undefined;
  try {
    task = await request.downloadFile(context, { url: address, header: headers, filePath: temporary });
    const download = task;
    await new Promise<void>((resolve, reject) => {
      download.on('complete', () => { resolve(); });
      download.on('fail', (code: number) => { reject(new Error('File download failed (' + code + ')')); });
      download.query().then((info: request.DownloadInfo) => {
        if (info.status === request.SESSION_SUCCESSFUL) resolve();
        if (info.status === request.SESSION_FAILED) reject(new Error('File download failed (' + info.failedReason + ')'));
      }).catch((error: Error) => { reject(error); });
    });
    api.requireConnection(version);
    const destination = await fs.open(destinations[0], fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try { await fs.copyFile(temporary, destination.fd); } finally { await fs.close(destination); }
    return true;
  } finally {
    if (task) await task.remove().catch(() => false);
    try { await fs.unlink(temporary); } catch (_) {}
  }
}
