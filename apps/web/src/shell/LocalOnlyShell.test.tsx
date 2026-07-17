import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same fake-plugin convention as `AppRoot.local.test.tsx`: `LocalOnlyShell`
// renders the real `<LocalNotesView>`, which is backed by the real Tauri v2
// `fs`/`dialog`/`store` plugins - mock them so its mount effect
// (`getFolder()`) resolves instead of throwing against a missing IPC bridge.
const { fsMocks, loadMock, invokeMock } = vi.hoisted(() => ({
  fsMocks: {
    mkdir: vi.fn(),
    readDir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    writeTextFile: vi.fn(),
  },
  loadMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => fsMocks);
vi.mock("@tauri-apps/plugin-store", () => ({ load: loadMock }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => Boolean((globalThis as { isTauri?: boolean }).isTauri),
}));

import { LocalOnlyShell } from "./LocalOnlyShell";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

describe("LocalOnlyShell", () => {
  afterEach(() => {
    setTauriFlag(undefined);
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders the ndBrain brand, a local-only indicator, and the local notes area (no folder configured yet)", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    render(<LocalOnlyShell onConnectServer={vi.fn()} />);

    expect(screen.getByText("ndBrain")).toBeInTheDocument();
    expect(screen.getByText(/local only/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
  });

  it("never mounts AuthProvider / fires a session-probe fetch", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LocalOnlyShell onConnectServer={vi.fn()} />);

    await screen.findByRole("button", { name: /choose folder/i });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('calls onConnectServer when "Connect to a server…" is clicked', async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    const onConnectServer = vi.fn();
    render(<LocalOnlyShell onConnectServer={onConnectServer} />);
    await screen.findByRole("button", { name: /choose folder/i });

    fireEvent.click(screen.getByRole("button", { name: /connect to a server/i }));

    expect(onConnectServer).toHaveBeenCalledTimes(1);
  });

  it("renders a theme toggle button", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    render(<LocalOnlyShell onConnectServer={vi.fn()} />);
    await screen.findByRole("button", { name: /choose folder/i });

    expect(screen.getByRole("button", { name: /switch to (dark|light) theme/i })).toBeInTheDocument();
  });

  it("shows 'no folder' in the statusbar when no local folder is configured", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    render(<LocalOnlyShell onConnectServer={vi.fn()} />);

    await screen.findByRole("button", { name: /choose folder/i });
    expect(screen.getByText("no folder")).toBeInTheDocument();
  });

  // The "folder configured" branch of the statusbar (path + note count +
  // "markdown · local") is covered at the `LocalNotesView` level instead
  // (`onStatusChange` tests in `local/LocalNotesView.test.tsx`, which inject
  // a fake store): `LocalOnlyShell` always renders the real, default
  // `LocalNotesView` backed by the shared `defaultLocalNotesStore` singleton
  // (see `local/defaultLocalNotesStore.ts`), whose own Tauri store caches its
  // resolved store promise for the module's lifetime — once any earlier test
  // in this file resolves it to a "no folder" store, later tests in the same
  // file can't make it resolve to a different one.
});
