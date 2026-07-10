import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, UnauthorizedError } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("ApiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("login: sends credentials + JSON body, returns token, caches it for the collab provider", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "abc123" }));
    const client = new ApiClient();

    const result = await client.login("julian", "hunter2");

    expect(result).toEqual({ username: "julian", token: "abc123" });
    expect(client.getCollabToken()).toBe("abc123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ username: "julian", password: "hunter2" });
  });

  it("login: 401 (bad credentials) throws UnauthorizedError and does not fire the global handler", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "bad_credentials", message: "invalid login" } }),
    );
    const client = new ApiClient();
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);

    const attempt = client.login("julian", "wrong");
    await expect(attempt).rejects.toThrow(UnauthorizedError);
    await expect(attempt).rejects.toMatchObject({ code: "bad_credentials" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(client.getCollabToken()).toBeNull();
  });

  it("notes call: sends credentials:include and parses the notes array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { notes: [{ path: "a.md", title: "A" }] }),
    );
    const client = new ApiClient();

    const notes = await client.listNotes();

    expect(notes).toEqual([{ path: "a.md", title: "A" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/notes");
    expect(init.credentials).toBe("include");
  });

  it("a protected call's 401 throws UnauthorizedError and fires the global unauthorized handler", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "unauthorized", message: "login required" } }),
    );
    const client = new ApiClient();
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);

    await expect(client.listNotes()).rejects.toThrow(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("logout: posts to /auth/logout and clears the cached collab token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "abc123" }));
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const client = new ApiClient();
    await client.login("julian", "hunter2");
    expect(client.getCollabToken()).toBe("abc123");

    await client.logout();

    expect(client.getCollabToken()).toBeNull();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("PUT notes/*: sends the content body against the joined wildcard path", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const client = new ApiClient();

    await client.putNote("myai/deploy.md", "# hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/notes/myai/deploy.md");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ content: "# hello" });
  });

  it("a non-401 error response throws a typed ApiError with status/code/message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: "conflict", message: "note exists" } }),
    );
    const client = new ApiClient();

    const attempt = client.moveNote("a.md", "b.md");
    await expect(attempt).rejects.toThrow(ApiError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      message: "note exists",
    });
  });

  it("search: encodes the query string and unwraps hits", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hits: [] }));
    const client = new ApiClient();

    await client.search("hello world");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/v1/search?q=hello%20world");
  });
});
