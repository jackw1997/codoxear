import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#39;" })[c]);
const exists = path => access(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const artifactRoot = resolve("artifacts");
await mkdir(artifactRoot, { recursive: true });
const suites = [
  ["customer-journey/results.json", "Daily customer journey", "Browser-created identities, membership, Computers, allowlists and agents. Controlled provider and managed-driver boundaries are recorded by the run.", process.env.CUSTOMER_JOURNEY_ARTIFACTS ?? "/opt/codoxear/artifacts/customer-journey"],
  ["registration-results.json", "Private initialization and provider-only OAuth sessions", "Controlled Google/Feishu providers; no live provider application acceptance."],
  ["agent-creation-results.json", "Agent creation form", "Focused launch-form validation; this fixture is separate from daily customer onboarding."],
  ["invitation-results.json", "Invitations, sharing and access layout", "Focused permissions and browser-layout fixture; the report states its tested scope."],
  ["client-updates/results.json", "Open client deployment update", "Empty client deployment notification and draft-preserving reload behavior; no authenticated application grants are seeded.", process.env.CLIENT_UPDATE_ARTIFACTS ?? "/opt/codoxear/artifacts/client-updates"],
];
const reports = [], pictures = [];
for (const [file, title, boundary, externalRoot] of suites) {
  const destination = join(artifactRoot, file);
  let source = destination;
  if (externalRoot && await exists(join(externalRoot, "results.json"))) {
    source = join(externalRoot, "results.json");
    await mkdir(join(artifactRoot, file.split("/")[0]), { recursive: true });
    if (resolve(source) !== resolve(destination)) await copyFile(source, destination);
  }
  if (!(await exists(source))) { reports.push({ file, title, boundary, missing: true }); continue; }
  const data = JSON.parse(await readFile(source, "utf8"));
  reports.push({ ...data, file, title, boundary });
  const names = data.screenshots ?? (file === "registration-results.json" ? ["registration-mobile.png", "registration-admin-mobile.png"] : []);
  for (const name of names) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\.png$/.test(name)) continue;
    const prefix = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const imageSource = join(dirname(source), name);
    const imageDestination = join(artifactRoot, prefix, name);
    if (!(await exists(imageSource))) continue;
    if (resolve(imageSource) !== resolve(imageDestination)) await copyFile(imageSource, imageDestination);
    pictures.push({ file: [prefix, name].filter(Boolean).join("/"), label: title + " · " + name });
  }
}
const tapPath = join(artifactRoot, "tests.tap");
const tap = await exists(tapPath) ? await readFile(tapPath, "utf8") : "";
const checks = report => (report.checks ?? report.steps ?? []).map(check => `<li>${typeof check === "string" ? esc(check) : `${check.passed ? "PASS" : "FAIL"} — ${esc(check.name)}`}</li>`).join("");
await writeFile(join(artifactRoot, "verification.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codoxear v2 verification evidence</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;background:#f6f3ec;color:#302e29;font:17px/1.6 system-ui}img{max-width:100%;border:1px solid #ccc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}section{border-top:1px solid #cfc5b7;margin-top:30px}a{color:#864d35}figure{margin:24px 0}figcaption{font-size:14px}</style><h1>Codoxear v2 verification evidence</h1><p>This page renders the available current suite reports. Missing reports are shown explicitly. Each run's failures, unavailable functions and external boundaries remain visible; browser fixtures do not establish live provider, live model or physical-device acceptance.</p>${tap ? `<p>${esc(tap.match(/# tests (\d+)/)?.[1])} automated tests · ${esc(tap.match(/# pass (\d+)/)?.[1])} passed · ${esc(tap.match(/# fail (\d+)/)?.[1])} failed</p>` : "<p>Automated test output was not produced.</p>"}${reports.map(report => `<section><h2>${esc(report.title)}</h2><p>${esc(report.boundary)}</p>${report.missing ? "<p>Report not produced in this artifact directory.</p>" : `<p>${report.passed === true ? "Run passed" : "Run did not pass"} · <a href="${esc(report.file)}">Raw results</a></p><ol>${checks(report)}</ol>${["clientSurface", "applicationActions", "oauthBoundary", "runtimeBoundary", "physicalBootstrapBoundary", "browserPermissionSetup"].filter(key => report[key]).map(key => `<p>${esc(report[key])}</p>`).join("")}${["failures", "errors", "unavailable"].filter(key => report[key]?.length).map(key => `<h3>${esc(key)}</h3><pre>${esc(JSON.stringify(report[key], null, 2))}</pre>`).join("")}`}</section>`).join("")}<h2>Captures from available runs</h2>${pictures.length ? pictures.map(picture => `<figure><img src="${esc(picture.file)}" alt="${esc(picture.label)}" loading="lazy"><figcaption>${esc(picture.label)}</figcaption></figure>`).join("") : "<p>No screenshots were produced.</p>"}${tap ? `<details><summary>Automated test output</summary><pre>${esc(tap)}</pre></details>` : ""}<p><a href="../README.html">Current setup</a> · <a href="../docs/requirements-reconciliation.md">Requirement decisions and historical evidence</a></p></html>`);
