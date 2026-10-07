import { readFile, writeFile } from "node:fs/promises";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const tap = await readFile("artifacts/tests.tap", "utf8");
const reports = [];
for (const [file, title, limit] of [
  [
    "demo-results.json",
    "Running M1 demo",
    "Actual installed Pi processes on three Computers and two independent hubs; scripted model replies. Full release remains No-Go.",
  ],
  [
    "browser-results.json",
    "Ownership and access in the browser",
    "Synthetic agent replies; real browser, HTTP, WebSocket and Computer processes.",
  ],
  [
    "distributed-results.json",
    "Independent identity service and hubs",
    "Separate processes and databases; synthetic agent runtime.",
  ],
  [
    "registration-results.json",
    "Google/Feishu registration and client-held signing keys",
    "Real browser, Hub, PKCE and signing proofs; controlled Google/Feishu identities, not live provider application acceptance.",
  ],
  [
    "real-runtime-results.json",
    "Installed Pi and the full workspace",
    "Actual CLI and shell tool execution; scripted model endpoint, not live model inference.",
  ],
  [
    "network-results.json",
    "Private computer network",
    "Separate Docker networks with verified TLS; no public-Internet deployment or production load test.",
  ],
]) {
  try {
    const data = JSON.parse(await readFile("artifacts/" + file, "utf8"));
    reports.push({ file, title, limit, ...data });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
const pictures = [
  [
    "demo-workspace.png",
    "Actual file read, edit and download in the running demo",
  ],
  [
    "10-workspace-grant.png",
    "Invited member edits an explicitly granted workspace",
  ],
  [
    "01-owner-chat.png",
    "Owner conversation through the outbound Computer connection",
  ],
  [
    "02-member-read-only.png",
    "A member’s open conversation after access becomes read-only",
  ],
  ["03-mobile.png", "Computer selection at mobile browser width"],
  ["04-independent-hub.png", "An independently deployed hub"],
  ["05-real-pi-browser.png", "The imported session of an actual Pi process"],
  ["06-workspace.png", "The established workspace through the hub"],
  ["registration-mobile.png", "Provider-only registration at mobile browser width"],
  [
    "08-workspace-read-only.png",
    "Full workspace after a live read-only downgrade",
  ],
  [
    "09-recovered-launch.png",
    "An existing Pi agent recovered without another process launch",
  ],
];
await writeFile(
  "artifacts/verification.html",
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codoxear v2 verification evidence</title><style>body{max-width:1100px;margin:50px auto;padding:0 25px;background:#f6f3ec;color:#302e29;font:17px/1.6 system-ui}img{max-width:100%;border:1px solid #ccc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}li{padding:5px}h1{font-size:clamp(30px,5vw,46px);line-height:1.15}.note{padding:20px;background:#eee2d8}figure{margin:30px 0}figcaption{font-size:15px;color:#666}a{color:#864d35}section{border-top:1px solid #cfc5b7;margin-top:35px}small{overflow-wrap:anywhere}</style><h1>Codoxear v2 — verification evidence</h1><p>${esc(tap.match(/# tests (\d+)/)?.[1])} automated tests · ${esc(tap.match(/# pass (\d+)/)?.[1])} passed · ${esc(tap.match(/# fail (\d+)/)?.[1])} failed</p><p class="note">This report records completed isolated checks. It does not certify the full design as implemented. Live identity providers, native SDK/device acceptance, physical background push delivery, native multi-hub subscriptions, complete delegated workspace permissions and deployment load/fault coverage remain acceptance gates. No production deployment was changed.</p>${reports.map((r) => `<section><h2>${esc(r.title)}</h2>${r.passed === false ? '<p class="note">This run did not complete successfully.</p>' : ""}<small>${esc(r.at)} · <a href="${esc(r.file)}">Raw results</a></small><p>${esc(r.limit)}</p><ol>${(r.steps ?? r.checks ?? []).map((s) => `<li>${typeof s === "string" ? "PASS — " + esc(s) : (s.passed ? "PASS" : "FAIL") + " — " + esc(s.name)}</li>`).join("")}</ol>${r.errors?.length ? "<pre>" + esc(JSON.stringify(r.errors, null, 2)) + "</pre>" : ""}</section>`).join("")}<p><a href="legacy-all.txt">Complete legacy suite output</a> · <a href="legacy-all.xml">Legacy JUnit results</a></p><h2>Browser captures</h2>${pictures.map(([file, label]) => `<figure><img src="${file}" alt="${esc(label)}" loading="eager"><figcaption>${esc(label)}</figcaption></figure>`).join("")}<details><summary>Automated test output</summary><pre>${esc(tap)}</pre></details><p><a href="../docs/acceptance.json">Full acceptance ledger</a> · <a href="../README.html">Implementation notes</a> · <a href="../../docs/multi-server-relay/final-design.html">Design with SVG diagrams</a></p></html>`,
);
