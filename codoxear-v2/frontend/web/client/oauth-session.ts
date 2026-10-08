import { canonicalOrigin } from "../../shared/context.js";
export class SessionSignInError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(
      status === 401
        ? "Sign in to this Hub again."
        : code === "login_method_not_allowed"
          ? "This sign-in type is blocked by the Hub owner. It remains saved."
          : "Hub session is temporarily unavailable. Retry when the Hub is reachable.",
    );
  }
}
export async function refreshSession(origin: string, refreshToken: string) {
  canonicalOrigin(origin);
  const response = await fetch(origin + "/oauth/token", {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: "codoxear-web",
      refresh_token: refreshToken,
    }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new SessionSignInError(response.status, value?.code ?? value?.error);
  if (
    typeof value?.access_token !== "string" ||
    typeof value?.refresh_token !== "string" ||
    !Number.isFinite(value.expires_in)
  )
    throw new Error("Hub returned an invalid session response");
  return value;
}
