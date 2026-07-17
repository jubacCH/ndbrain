import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Some Tauri-gated tests below render `AddSourceView`'s folder path (via
// `SourcesProvider`), which is backed by the real Tauri v2
// `fs`/`dialog`/`store` plugins - mock them the same way
// `SourcesProvider.test.tsx` does, so folder sources can grant fs access
// (`allow_local_notes_folder`) without a real IPC bridge.
const { loadMock, invokeMock, openMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, confirm: vi.fn() }));
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

describe("App in Tauri with no configured sources", () => {
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
    vi.clearAllMocks();
  });

  it("shows AddSourceView instead of mounting AuthProvider, so the session probe never fires against an empty base url", async () => {
    render(<App />);

    expect(await screen.findByText(/add a source/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adding a server switches to the normal login flow once addServer succeeds", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/login")) {
        return Promise.resolve(jsonResponse(200, { token: "tok" }));
      }
      return Promise.resolve(jsonResponse(401, { error: { code: "unauthorized", message: "login required" } }));
    });
    render(<App />);
    await screen.findByText(/add a source/i);

    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "My Server" } });
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: "https://brain.example.com" } });
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows an inline error and stays on AddSourceView when the login fails, leaving the registry untouched", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(401, { error: { code: "bad_credentials", message: "invalid credentials" } })),
    );
    render(<App />);
    await screen.findByText(/add a source/i);

    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "My Server" } });
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: "https://brain.example.com" } });
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/add a source/i)).toBeInTheDocument();
    expect(localStorage.getItem("ndbrain.sources")).toBeNull();
  });

  it("adding a folder switches to the normal login flow once addFolder succeeds", async () => {
    openMock.mockResolvedValue("/Users/x/notes");
    invokeMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: "unauthorized", message: "login required" } }));
    render(<App />);
    await screen.findByText(/add a source/i);

    fireEvent.click(screen.getByRole("tab", { name: /folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    await screen.findByLabelText(/label/i);
    fireEvent.click(screen.getByRole("button", { name: /add folder/i }));

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    openMock.mockResolvedValue(null);
    render(<App />);
    await screen.findByText(/add a source/i);

    fireEvent.click(screen.getByRole("tab", { name: /folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/label/i)).not.toBeInTheDocument();
    expect(screen.getByText(/add a source/i)).toBeInTheDocument();
  });
});
