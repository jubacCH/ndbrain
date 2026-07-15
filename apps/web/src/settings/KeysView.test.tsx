import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListEntry } from "../api/client";
import { KeysView, type KeysClient } from "./KeysView";

const KEY_A: ApiKeyListEntry = {
  name: "ci-bot",
  namespace: "default",
  canWrite: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-02-01T00:00:00.000Z",
  expiresAt: null,
};

function makeClient(overrides: Partial<KeysClient> = {}): KeysClient {
  return {
    listKeys: vi.fn().mockResolvedValue([]),
    createKey: vi.fn().mockResolvedValue("ndb_generatedsecret"),
    revokeKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("KeysView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a loading state before keys arrive", () => {
    const client = makeClient({ listKeys: vi.fn((): Promise<ApiKeyListEntry[]> => new Promise(() => {})) });
    render(<KeysView client={client} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no keys", async () => {
    const client = makeClient({ listKeys: vi.fn().mockResolvedValue([]) });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());
  });

  it("lists existing keys with their namespace and access level", async () => {
    const client = makeClient({ listKeys: vi.fn().mockResolvedValue([KEY_A]) });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("shows an error state when loading keys fails", async () => {
    const client = makeClient({ listKeys: vi.fn().mockRejectedValue(new Error("boom")) });
    render(<KeysView client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("creates a key and shows it once with a copy-now warning", async () => {
    const createKey = vi.fn().mockResolvedValue("ndb_supersecretvalue");
    const client = makeClient({ createKey });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "new-key" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "myai" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /can write/i }));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(createKey).toHaveBeenCalledWith("new-key", "myai", true, undefined));

    expect(screen.getByDisplayValue("ndb_supersecretvalue")).toBeInTheDocument();
    expect(screen.getByText(/won.t be shown again/i)).toBeInTheDocument();
  });

  it("passes an expiry date through to createKey when provided", async () => {
    const createKey = vi.fn().mockResolvedValue("ndb_x");
    const client = makeClient({ createKey });
    render(<KeysView client={client} />);
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "k" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "ns" } });
    fireEvent.change(screen.getByLabelText(/expires/i), { target: { value: "2027-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(createKey).toHaveBeenCalledWith("k", "ns", false, "2027-01-01"));
  });

  it("does not persist the newly created key to localStorage", async () => {
    const client = makeClient({ createKey: vi.fn().mockResolvedValue("ndb_donotpersist") });
    render(<KeysView client={client} />);
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "k" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "ns" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(screen.getByDisplayValue("ndb_donotpersist")).toBeInTheDocument());

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key)).not.toContain("ndb_donotpersist");
    }
  });

  it("dismissing the shown key clears it from view", async () => {
    const client = makeClient({ createKey: vi.fn().mockResolvedValue("ndb_temp") });
    render(<KeysView client={client} />);
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "k" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "ns" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(screen.getByDisplayValue("ndb_temp")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /done|dismiss|copied/i }));

    expect(screen.queryByDisplayValue("ndb_temp")).not.toBeInTheDocument();
  });

  it("revokes a key after confirmation and refreshes the list", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const listKeys = vi.fn().mockResolvedValueOnce([KEY_A]).mockResolvedValueOnce([]);
    const revokeKey = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ listKeys, revokeKey });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith("ci-bot"));
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());
  });

  it("does not revoke when the confirmation is dismissed", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const revokeKey = vi.fn();
    const client = makeClient({ listKeys: vi.fn().mockResolvedValue([KEY_A]), revokeKey });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    expect(revokeKey).not.toHaveBeenCalled();
  });

  it("shows an error when revoking a key fails", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const revokeKey = vi.fn().mockRejectedValue(new Error("boom"));
    const client = makeClient({ listKeys: vi.fn().mockResolvedValue([KEY_A]), revokeKey });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to revoke/i);
  });

  it("uses the native tauri dialog (not window.confirm) to revoke inside the desktop shell", async () => {
    // Regression: window.confirm is dead in macOS WKWebView, so the desktop
    // shell must route the revoke confirmation through @tauri-apps/plugin-dialog.
    const dialogConfirm = vi.fn().mockResolvedValue(true);
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ confirm: dialogConfirm }));
    vi.stubGlobal("isTauri", true);
    const windowConfirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", windowConfirm);
    const revokeKey = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      listKeys: vi.fn().mockResolvedValueOnce([KEY_A]).mockResolvedValueOnce([]),
      revokeKey,
    });
    render(<KeysView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith("ci-bot"));
    expect(dialogConfirm).toHaveBeenCalled();
    expect(windowConfirm).not.toHaveBeenCalled();
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });

  it("clears the shown key secret once the view stops being active, not only on unmount", async () => {
    const client = makeClient({ createKey: vi.fn().mockResolvedValue("ndb_temp") });
    const { rerender } = render(<KeysView client={client} active />);
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "k" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "ns" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => expect(screen.getByDisplayValue("ndb_temp")).toBeInTheDocument());

    rerender(<KeysView client={client} active={false} />);

    expect(screen.queryByDisplayValue("ndb_temp")).not.toBeInTheDocument();
  });
});
