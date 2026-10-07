/** Shared by the independent client and the transitional management page. */
export const invitationFields = () => `
<label class="connectionField"><span>Invite by</span><select name="inviteMethod" aria-label="Invite by">
  <option value="google">Google</option><option value="feishu">Feishu</option><option value="email">Email (verified Google address)</option>
</select></label>
<div data-invite-target="email" hidden><label class="connectionField"><span>Email</span><input name="email" type="email" autocomplete="email" required disabled></label><p class="connectionHint">Use the address verified by the recipient’s Google account.</p></div>
<div data-invite-target="provider" hidden>
  <p class="connectionHint">Ask the recipient for the invitation details shown in their hub’s Sign-in methods. Display names do not identify an account.</p>
  <label class="connectionField"><span>Sign-in connection</span><input name="connection" maxlength="200" required disabled></label>
  <label class="connectionField"><span>Identity ID</span><input name="subject" maxlength="300" required disabled></label>
  <label class="connectionField"><span>Tenant (optional)</span><input name="tenant" maxlength="200" disabled></label>
</div>`;

export function wireInvitationFields(form: HTMLFormElement) {
  const method = form.elements.namedItem("inviteMethod") as HTMLSelectElement;
  const update = () => {
    const active = method.value === "email" ? "email" : "provider";
    for (const group of form.querySelectorAll<HTMLElement>(
      "[data-invite-target]",
    )) {
      group.hidden = group.dataset.inviteTarget !== active;
      for (const input of group.querySelectorAll<HTMLInputElement>("input"))
        input.disabled = group.hidden;
    }
    const output = form.querySelector<HTMLElement>("output, .invite-result");
    if (output) {
      output.textContent = "";
      output.hidden = true;
    }
  };
  method.onchange = update;
  update();
}

export function invitationBody(data: FormData) {
  const value = (key: string) => String(data.get(key) ?? "").trim();
  const method = value("inviteMethod");
  return {
    target:
      method === "email"
        ? { method, email: value("email") }
        : {
            method,
            connection: value("connection"),
            subject: value("subject"),
            tenant: value("tenant") || null,
          },
    role: value("role"),
  };
}
