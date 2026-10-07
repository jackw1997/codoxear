import { appearance } from "../shared/ui.js";
import { esc, field, icon, submit, message, loginHeading } from "./views.js";
const root = document.querySelector<HTMLElement>("#hubLogin")!;
const query = new URLSearchParams(location.search),
  continuation = query.get("continue");
const resume = () => {
  if (
    continuation?.startsWith("/oauth/authorize?") &&
    new URL(continuation, location.origin).origin === location.origin
  ) {
    location.assign(continuation);
    return true;
  }
  return false;
};
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? "Sign-in failed");
  return v;
}
const theme = (await appearance()) as {
  applyTheme: (state: { family: string; mode: string }) => void;
};
const source = continuation
  ? new URL(continuation, location.origin).searchParams
  : query;
if (
  ["clay", "slate", "paper"].includes(source.get("theme") ?? "") &&
  ["system", "light", "dark"].includes(source.get("mode") ?? "")
)
  theme.applyTheme({ family: source.get("theme")!, mode: source.get("mode")! });
async function render() {
  root.setAttribute("aria-busy", "true");
  const options = await api("/api/v1/auth/options");
  let me: any = null;
  try {
    me = await api("/api/v1/me");
  } catch {}
  root.removeAttribute("aria-busy");
  const expectedAccount = query.get("account");
  if (me && expectedAccount && me.id !== expectedAccount) {
    root.innerHTML = ` ${loginHeading("Switch account", location.origin)}<p>Signed in as ${esc(me.name)}. Sign out before managing the account selected in Hubs & computers.</p><button class="primary" data-signout>Sign out</button><p role="alert" class="connectionError"></p>`;
    root.querySelector<HTMLButtonElement>("[data-signout]")!.onclick = () => {
      void api("/api/v1/auth/logout", {}).then(render).catch(error);
    };
    return;
  }
  const fresh = me && Date.now() - me.context.authenticatedAt < 300000;
  root.innerHTML = `${loginHeading(me ? "Sign-in methods" : "Codoxear login", location.origin)}${me ? `<p>Signed in as <strong>${esc(me.name)}</strong></p>` : ""}<form id="password" class="connectionForm">${field("Email", `<input name="email" type="email" required autocomplete="username" placeholder="you@example.com" value="${esc(me?.email?.endsWith("@accounts.invalid") ? "" : (me?.email ?? ""))}">`)}<div class="connectionPassword">${field("Password", `<span class="connectionPasswordInput"><input name="password" type="password" required autocomplete="current-password" placeholder="Password"><button class="connectionIconButton" type="button" data-reveal aria-label="Show password" aria-pressed="false">${icon("eye")}</button></span>`)}<button class="primary" type="submit">${me ? "Verify" : "Sign in"}</button></div></form><p class="connectionHint">${me ? "Verify your password before linking a new sign-in method." : "Sign in to connect this hub."}</p><p role="alert" class="connectionError"></p><div class="connectionMethods" id="providers" hidden></div><div class="connectionStack" id="codes" hidden></div>${me ? '<div class="connectionStack connectionSection" id="identities"></div><button id="signout">Sign out of this hub</button>' : ""}`;
  const password = root.querySelector<HTMLFormElement>("#password")!;
  submit(
    password,
    async (data) => {
      await api("/api/v1/auth/password", {
        email: data.get("email"),
        password: data.get("password"),
      });
      if (!resume()) await render();
    },
    error,
  );
  root.querySelector<HTMLButtonElement>("[data-reveal]")!.onclick = (e) => {
    const input = password.querySelector<HTMLInputElement>("[name=password]")!,
      button = e.currentTarget as HTMLButtonElement;
    input.type = input.type === "password" ? "text" : "password";
    button.setAttribute(
      "aria-label",
      input.type === "password" ? "Show password" : "Hide password",
    );
    button.setAttribute("aria-pressed", String(input.type === "text"));
  };
  const providers = root.querySelector<HTMLElement>("#providers")!;
  providers.hidden = !options.providers.length;
  providers.innerHTML = options.providers
    .map(
      (p: any) =>
        `<a class="connectionProvider" href="/auth/${encodeURIComponent(p.id)}/start?${new URLSearchParams({ ...(fresh && !continuation ? { link: "1" } : {}), ...(continuation ? { continue: continuation } : {}) })}">${fresh && !continuation ? "Link" : "Sign in with"} ${esc(p.id)}</a>`,
    )
    .join("");
  const codes = root.querySelector<HTMLElement>("#codes")!;
  codes.hidden = !options.codes.length;
  for (const method of options.codes) {
    const form = document.createElement("form");
    form.className = "connectionForm connectionSection";
    form.innerHTML = `${field(method === "email" ? "Email code" : "Mobile number", `<input name="target" type="${method === "email" ? "email" : "tel"}" required autocomplete="${method === "email" ? "email" : "tel"}">`)}<div class="connectionActions"><button type="submit">${fresh && !continuation ? "Link identity" : "Send code"}</button></div>`;
    submit(
      form,
      async (data) => {
        const value = await api("/api/v1/auth/code", {
          method,
          target: data.get("target"),
          link: !!fresh && !continuation,
        });
        form.innerHTML = `${field("Verification code", '<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required>')}<div class="connectionActions"><button class="primary" type="submit">Verify code</button></div>`;
        submit(
          form,
          async (data) => {
            await api("/api/v1/auth/code/verify", {
              challengeId: value.challengeId,
              transaction: value.transaction,
              code: data.get("code"),
            });
            if (!resume()) await render();
          },
          error,
        );
      },
      error,
    );
    codes.append(form);
  }
  if (me) {
    const list = root.querySelector<HTMLElement>("#identities")!;
    list.hidden = !me.identities.length;
    list.innerHTML = me.identities
      .map(
        (i: any) =>
          `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(i.connection)}</strong><span class="connectionHint">${esc(i.subject)}${i.tenant ? " · " + esc(i.tenant) : ""}</span></span><button data-invitation="${esc(i.id)}">Copy invitation details</button><button data-unlink="${esc(i.id)}">Unlink</button></div>`,
      )
      .join("");
    for (const b of list.querySelectorAll<HTMLButtonElement>(
      "[data-invitation]",
    ))
      b.onclick = () => {
        const identity = me.identities.find(
          (i: any) => i.id === b.dataset.invitation,
        );
        const { method, connection, subject, tenant } = identity;
        void navigator.clipboard
          .writeText(
            JSON.stringify(
              { method, connection, subject, tenant: tenant ?? null },
              null,
              2,
            ),
          )
          .then(() => {
            b.textContent = "Copied";
          })
          .catch(error);
      };
    for (const b of list.querySelectorAll<HTMLButtonElement>("[data-unlink]"))
      b.onclick = () => {
        void api(
          "/api/v1/me/identities/" + b.dataset.unlink,
          undefined,
          "DELETE",
        )
          .then(render)
          .catch(error);
      };
    root.querySelector<HTMLButtonElement>("#signout")!.onclick = () => {
      void api("/api/v1/auth/logout", {}).then(render).catch(error);
    };
  }
}
function error(e: unknown) {
  const target = root.querySelector("[role=alert]");
  if (target) target.textContent = message(e);
}
root.innerHTML =
  loginHeading("Codoxear login", location.origin) +
  '<p class="connectionHint" role="status">Loading sign-in…</p>';
void render().catch((e) => {
  root.removeAttribute("aria-busy");
  root.innerHTML =
    loginHeading("Unable to load sign-in", location.origin) +
    '<p role="alert" class="connectionError"></p><button class="primary" data-retry>Retry</button>';
  error(e);
  root.querySelector<HTMLButtonElement>("[data-retry]")!.onclick = () =>
    void render().catch(error);
});
