import { createThemeController } from "../legacy/app_theme.js";
import { loginHeading } from "./views.js";
import { enhanceUI } from "../ui/index.js";
const pageUI = enhanceUI(document);
window.addEventListener("beforeunload", () => pageUI.destroy(), { once: true });
createThemeController({
  documentTarget: document,
  storageGetItem: (key: string) => localStorage.getItem(key),
  storageSetItem: (key: string, value: string) => {
    localStorage.setItem(key, value);
    return true;
  },
  storageRemoveItem: (key: string) => localStorage.removeItem(key),
  matchMedia: (query: string) => matchMedia(query),
  versionedAssetPath: (path: string) => "/" + path,
});
const query = new URLSearchParams(location.search);
history.replaceState(null, "", "/auth-callback");
const root = document.querySelector<HTMLElement>("#callback")!;
if (window.opener && query.get("state") && query.get("code")) {
  root.innerHTML =
    loginHeading(
      "Connecting your hub",
      "Return to Codoxear when this window closes.",
    ) + '<p role="status" class="connectionHint">Completing hub sign-in…</p>';
  window.opener.postMessage(
    {
      type: "codoxear-login",
      state: query.get("state"),
      code: query.get("code"),
      issuer: query.get("iss"),
    },
    location.origin,
  );
} else {
  root.innerHTML =
    loginHeading(
      "Return to Codoxear",
      "Open Hubs & computers and connect your hub again.",
    ) +
    '<p class="connectionHint">This sign-in window no longer has a connection to the app.</p>';
}
