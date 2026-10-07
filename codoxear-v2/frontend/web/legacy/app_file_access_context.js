let accessKey = () => "";
const observers = new Set();
export function configureFileAccessContext(key) {
  if (typeof key !== "function") throw new TypeError("File access context must be a function");
  accessKey = key;
}
export function fileAccessContext(sessionId) { return String(accessKey(sessionId) || ""); }
export function notifyFileAccessContext(sessionId) { for (const observer of observers) observer(sessionId); }
export function observeFileAccessContext(observer) { observers.add(observer); return () => observers.delete(observer); }
