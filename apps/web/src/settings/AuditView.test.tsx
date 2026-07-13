import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../api/client";
import { AuditView, type AuditClient } from "./AuditView";

const ENTRY_A: AuditEntry = {
  ts: "2026-03-15T10:30:00.000Z",
  keyName: "ci-bot",
  tool: "notes.get",
  target: "notes/a.md",
  allowed: true,
};

const ENTRY_B: AuditEntry = {
  ts: "2026-03-15T10:31:00.000Z",
  keyName: null,
  tool: "notes.delete",
  target: null,
  allowed: false,
};

function makeClient(overrides: Partial<AuditClient> = {}): AuditClient {
  return {
    audit: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("AuditView", () => {
  it("shows a loading state before entries arrive", () => {
    const client = makeClient({ audit: vi.fn((): Promise<AuditEntry[]> => new Promise(() => {})) });
    render(<AuditView client={client} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no entries", async () => {
    const client = makeClient({ audit: vi.fn().mockResolvedValue([]) });
    render(<AuditView client={client} />);

    await waitFor(() => expect(screen.getByText(/no audit entries/i)).toBeInTheDocument());
  });

  it("shows an error state when loading fails", async () => {
    const client = makeClient({ audit: vi.fn().mockRejectedValue(new Error("boom")) });
    render(<AuditView client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("renders rows with formatted time, key name, tool, target and an allowed badge", async () => {
    const client = makeClient({ audit: vi.fn().mockResolvedValue([ENTRY_A, ENTRY_B]) });
    render(<AuditView client={client} />);

    await waitFor(() => expect(screen.getByText("ci-bot")).toBeInTheDocument());
    expect(screen.getByText("notes.get")).toBeInTheDocument();
    expect(screen.getByText("notes/a.md")).toBeInTheDocument();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Allowed", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Denied", { selector: "span" })).toBeInTheDocument();
  });

  it("shows an em dash for entries without a key name or target", async () => {
    const client = makeClient({ audit: vi.fn().mockResolvedValue([ENTRY_B]) });
    render(<AuditView client={client} />);

    await waitFor(() => expect(screen.getByText("notes.delete")).toBeInTheDocument());
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("passes the selected limit through to the client and reloads when it changes", async () => {
    const audit = vi.fn().mockResolvedValue([]);
    const client = makeClient({ audit });
    render(<AuditView client={client} />);

    await waitFor(() => expect(audit).toHaveBeenCalledWith(100));

    fireEvent.change(screen.getByLabelText(/limit|show/i), { target: { value: "200" } });

    await waitFor(() => expect(audit).toHaveBeenCalledWith(200));
  });
});
