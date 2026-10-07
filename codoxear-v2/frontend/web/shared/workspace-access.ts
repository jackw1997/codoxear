import { escapeHtml as esc } from "./ui.js";
type Root = { id: string; name: string; path: string };
type Grant = { workspaceId: string; access: string; paths?: string[]; git?: boolean; uploads?: boolean; transcode?: boolean };
type Member = { userId: string; name?: string; email?: string; workspaceAccess?: string | null; workspaceGrants?: Grant[] };
export type WorkspaceReview = { path: string | null; roots?: Root[] };
export function workspaceAccessFields(member: Member, review: WorkspaceReview) {
  const roots = review.roots ?? [{ id: "default", name: "Default workspace", path: review.path ?? "Unavailable" }];
  const first = member.workspaceGrants?.find(g => g.workspaceId === "default") ?? member.workspaceGrants?.[0];
  return `<form class="workspace-form connectionForm" data-member="${esc(member.userId)}"><h3>Workspace access for ${esc(member.name ?? member.email ?? member.userId)}</h3><label>Approved workspace<select name="workspaceId" aria-label="Approved workspace">${roots.map(root => `<option value="${esc(root.id)}" ${first?.workspaceId === root.id ? "selected" : ""}>${esc(root.name)} · ${esc(root.path)}</option>`).join("")}</select></label><label>Workspace access for ${esc(member.name ?? member.email ?? member.userId)}<select name="access" aria-label="Workspace access for ${esc(member.name ?? member.email ?? member.userId)}"><option value="">No file access</option><option value="read">Read files</option><option value="write">Read and edit files</option></select></label><label>Allowed files or directories<textarea name="paths" rows="3" placeholder="One relative path per line; . shares all working files"></textarea></label><label class="checkField"><input type="checkbox" name="git"><span>Read the complete repository history and Git diffs</span></label><p class="connectionHint">Git access shares the entire repository, including committed files outside the allowed working-file paths. Approve a complete repository root.</p><label class="checkField"><input type="checkbox" name="uploads"><span>Upload and send this member’s attachments</span></label><label class="checkField"><input type="checkbox" name="transcode"><span>Generate video previews for allowed files</span></label><button type="submit">Save file access</button><p class="connectionStatus" role="status"></p></form>`;
}
export function workspaceRootFields(review: WorkspaceReview) {
  return `<section class="connectionSection"><h3>Approved workspace roots</h3><p class="connectionHint">Choose directories on this Computer. Grants refer to stable IDs and stop if a directory is replaced.</p>${(review.roots ?? []).map(root => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(root.name)}</strong><code>${esc(root.path)}</code></span>${root.id !== "default" ? `<button type="button" data-remove-workspace="${esc(root.id)}">Remove workspace</button>` : ""}</div>`).join("")}<form class="workspace-root-form connectionForm"><label>Workspace name<input name="name" maxlength="120" required></label><label>Absolute directory on this Computer<input name="path" maxlength="4096" required placeholder="/home/you/project"></label><button type="submit">Approve workspace</button><p role="status" class="connectionStatus"></p></form></section>`;
}
export function bindWorkspaceGrant(form: HTMLFormElement, member: Member) {
  const select = form.elements.namedItem("workspaceId") as HTMLSelectElement;
  const load = () => {
    const grant = member.workspaceGrants?.find(g => g.workspaceId === select.value);
    (form.elements.namedItem("access") as HTMLSelectElement).value = grant?.access ?? (select.value === "default" ? member.workspaceAccess ?? "" : "");
    (form.elements.namedItem("paths") as HTMLTextAreaElement).value = (grant?.paths ?? ["."]).join("\n");
    for (const name of ["git", "uploads", "transcode"] as const) (form.elements.namedItem(name) as HTMLInputElement).checked = grant?.[name] ?? false;
  };
  select.addEventListener("change", load);
  load();
}
export function workspaceGrantBody(data: FormData) {
  return { workspaceId: data.get("workspaceId"), access: data.get("access") || null, paths: String(data.get("paths") ?? ".").split(/\r?\n/).map(s => s.trim()).filter(Boolean), git: data.get("git") === "on", uploads: data.get("uploads") === "on", transcode: data.get("transcode") === "on" };
}
