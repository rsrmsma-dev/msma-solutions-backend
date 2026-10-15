// Calls to the HeyHR API server (server/). In development Vite proxies /api to it.
// VITE_API_MODE=server turns it on (see .env.development); without it the app
// runs on browser storage alone, as before.

// Read defensively: outside Vite (e.g. the API server type-checking shared code) there is no import.meta.env.
export const serverMode = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_MODE === "server";

/** Fired when the server says the session is gone, so the app returns to sign-in. */
export const SIGNED_OUT_EVENT = "heyhr:signed-out";

export class ApiError extends Error {
  status: number;
  /** The server's error code, when it sends one (e.g. SEAT_LIMIT_REACHED). */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    const { error: message, code } = (data as { error?: string; code?: string } | undefined) ?? {};
    // No message from our server: the dev proxy couldn't reach it (it isn't running).
    if (!message && res.status >= 500) throw new ApiError("Can't reach the HeyHR server. Start it with: npm run server", res.status);
    throw new ApiError(message ?? "Something went wrong. Try again.", res.status, code);
  }
  return data as T;
}
