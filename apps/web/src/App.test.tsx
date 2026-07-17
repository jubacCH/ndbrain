import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The local-only mode tests below render `LocalOnlyShell` -> `LocalNotesView`,
// which is backed by the real Tauri v2 `fs`/`dialog`/`store` plugins - mock
// them the same way `AppRoot.local.test.tsx` does, so the mount effect
// (`getFolder()`) resolves instead of throwing against a missing IPC bridge.
const { loadMock, invokeMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: loadMock }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => Boolean((globalThis as { isTauri?: boolean }).isTauri),
}));

import App from "./App";
import { getServerUrl } from "./api/base-url";
import { isLocalOnly, setLocalOnly } from "./local/localOnlyMode";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("App", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the login form when there is no valid session cookie", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "unauthorized", message: "login required" } }),
    );
    render(<App />);

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows the authenticated shell when the session probe succeeds", async () => {
    // Two calls now hit `/notes`: the session probe in `useAuth`, and `NoteTree`'s
    // own fetch once it mounts under the authed shell. Each `Response` body can
    // only be read once, so build a fresh one per call rather than reusing one.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { notes: [] })));
    render(<App />);

    expect(await screen.findByText("ndBrain")).toBeInTheDocument();
    expect(screen.getByText("Select a note to start editing.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no notes yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});

describe("App in Tauri without a configured server url", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriFlag(undefined);
    localStorage.clear();
  });

  it("shows the server url form instead of mounting AuthProvider, so the session probe never fires against an empty base url", async () => {
    render(<App />);

    expect(await screen.findByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches to the normal login flow once a server url is connected", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://brain.example.com")) {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "login required" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText(/server url/i), {
      target: { value: "https://brain.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(getServerUrl()).toBe("https://brain.example.com");
  });

  it("offers a local-only option that switches to LocalOnlyShell without ever calling fetch, and persists across a remount", async () => {
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    const { unmount } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /local notes only/i }));

    expect(await screen.findByText(/local only/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/server url/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isLocalOnly()).toBe(true);

    unmount();
    render(<App />);
    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("App in Tauri with local-only mode already enabled", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setTauriFlag(true);
    setLocalOnly(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriFlag(undefined);
    localStorage.clear();
  });

  it("renders LocalOnlyShell directly, skipping the server url screen, without mounting AuthProvider", async () => {
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    render(<App />);

    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/server url/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    // No session-probe fetch (AuthProvider never mounted) and no reachability
    // ping (ServerUrlView never mounted either).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Connect to a server…" clears the flag and returns to the normal server url screen', async () => {
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    render(<App />);
    await screen.findByRole("button", { name: /choose folder/i });

    fireEvent.click(screen.getByRole("button", { name: /connect to a server/i }));

    expect(await screen.findByLabelText(/server url/i)).toBeInTheDocument();
    expect(isLocalOnly()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
