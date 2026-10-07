/** Shared by the independent client and the transitional management page. */
export const invitationFields = () => `
<label class="connectionField"><span>Invite by</span><select name="inviteMethod" aria-label="Invite by">
  <option value="email">Email</option><option value="phone">Phone</option>
  <option value="feishu">Feishu</option><option value="wechat">WeChat</option><option value="oidc">Other sign-in provider</option>
</select></label>
<div data-invite-target="email"><label class="connectionField"><span>Email</span><input name="email" type="email" autocomplete="email" required></label></div>
<div data-invite-target="phone" hidden><label class="connectionField"><span>Phone number</span><input name="phone" type="tel" autocomplete="tel" placeholder="+8613800138000" pattern="\\+[1-9][0-9]{7,14}" required disabled></label><p class="connectionHint">Use the full international number, including +country code.</p></div>
<div data-invite-target="provider" hidden>
  <p class="connectionHint">Ask the recipient for the invitation details shown in their hub’s Sign-in methods. Display names do not identify an account.</p>
  <label class="connectionField"><span>Sign-in connection</span><input name="connection" maxlength="200" required disabled></label>
  <label class="connectionField"><span>Identity ID</span><input name="subject" maxlength="300" required disabled></label>
  <label class="connectionField"><span>Tenant (optional)</span><input name="tenant" maxlength="200" disabled></label>
</div>`;

export function wireInvitationFields(form: HTMLFormElement) {
  const method = form.elements.namedItem("inviteMethod") as HTMLSelectElement;
  const update = () => {
    const active = ["email", "phone"].includes(method.value)
      ? method.value
      : "provider";
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
        : method === "phone"
          ? { method, phone: value("phone") }
          : {
              method,
              connection: value("connection"),
              subject: value("subject"),
              tenant: value("tenant") || null,
            },
    role: value("role"),
  };
}
