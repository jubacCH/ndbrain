import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuthClient } from "../api/client";
import { AuthProvider, useAuth } from "./useAuth";

function fakeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    listNotes: vi.fn().mockResolvedValue([]),
    setUnauthorizedHandler: vi.fn(),
    ...overrides,
  };
}

describe("useAuth", () => {
  it("starts in a loading state, then becomes authenticated when the session probe succeeds", async () => {
    const client = fakeClient({ listNotes: vi.fn().mockResolvedValue([{ path: "a.md", title: "A" }]) });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authenticated).toBe(true);
  });

  it("becomes unauthenticated when the session probe rejects (no valid cookie)", async () => {
    const client = fakeClient({ listNotes: vi.fn().mockRejectedValue(new Error("401")) });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authenticated).toBe(false);
    expect(result.current.username).toBeNull();
  });

  it("login() calls client.login and flips to authenticated with username + token", async () => {
    const client = fakeClient({
      listNotes: vi.fn().mockRejectedValue(new Error("401")),
      login: vi.fn().mockResolvedValue({ username: "julian", token: "tok-1" }),
    });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login("julian", "hunter2");
    });

    expect(client.login).toHaveBeenCalledWith("julian", "hunter2");
    expect(result.current.authenticated).toBe(true);
    expect(result.current.username).toBe("julian");
    expect(result.current.token).toBe("tok-1");
  });

  it("logout() calls client.logout and resets to unauthenticated", async () => {
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({ username: "julian", token: "tok-1" }),
    });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("julian", "hunter2");
    });
    expect(result.current.authenticated).toBe(true);

    await act(async () => {
      await result.current.logout();
    });

    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(result.current.authenticated).toBe(false);
    expect(result.current.username).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it("registers a global unauthorized handler that resets state when the session dies mid-app", async () => {
    let capturedHandler: (() => void) | null = null;
    const client = fakeClient({
      login: vi.fn().mockResolvedValue({ username: "julian", token: "tok-1" }),
      setUnauthorizedHandler: vi.fn((handler) => {
        capturedHandler = handler;
      }),
    });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("julian", "hunter2");
    });
    expect(result.current.authenticated).toBe(true);
    expect(capturedHandler).not.toBeNull();

    act(() => {
      capturedHandler!();
    });

    expect(result.current.authenticated).toBe(false);
  });

  it("throws when useAuth is used outside an AuthProvider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/AuthProvider/);
  });
});
