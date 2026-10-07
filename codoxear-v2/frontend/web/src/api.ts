export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const context = document.getElementById("codoxear-hub-context");
  const hubId = context ? JSON.parse(context.textContent ?? "{}").hubId : null;
  const target = hubId
    ? "/gateway/hubs/" + encodeURIComponent(hubId) + path
    : path;
  const response = await fetch(target, {
    method,
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      value.code ?? "request_failed",
      value.error ?? "Request failed",
    );
  return value as T;
}
