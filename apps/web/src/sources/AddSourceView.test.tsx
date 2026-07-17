import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pickFolderDialogMock } = vi.hoisted(() => ({
  pickFolderDialogMock: vi.fn(),
}));

vi.mock("../local/localStore", () => ({
  pickFolderDialog: pickFolderDialogMock,
}));

import { AddSourceView } from "./AddSourceView";
import { SourcesContext, type SourcesContextValue } from "./SourcesProvider";

function renderAddSourceView(overrides: Partial<SourcesContextValue> = {}) {
  const value: SourcesContextValue = {
    sources: [],
    addServer: vi.fn(),
    addFolder: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
  const onDone = vi.fn();
  render(
    <SourcesContext.Provider value={value}>
      <AddSourceView onDone={onDone} />
    </SourcesContext.Provider>,
  );
  return { value, onDone };
}

describe("AddSourceView", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the ndBrain brand and an explanation of the two ways to add a source", () => {
    renderAddSourceView();

    expect(screen.getByText("ndBrain")).toBeInTheDocument();
    expect(screen.getByText(/add a source/i)).toBeInTheDocument();
    expect(screen.getByText(/local folders? .* (stay|remain|never leave) .* device/i)).toBeInTheDocument();
  });

  describe("server path", () => {
    it("submits the form and calls addServer with the entered values, then onDone", async () => {
      const addServer = vi.fn().mockResolvedValue(undefined);
      const { onDone } = renderAddSourceView({ addServer });

      fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "My Server" } });
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: "https://brain.example.com" } });
      fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret" } });
      fireEvent.click(screen.getByRole("button", { name: /add server|connect/i }));

      await waitFor(() =>
        expect(addServer).toHaveBeenCalledWith("My Server", "https://brain.example.com", "alice", "secret"),
      );
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    });

    it("shows an inline error and does not call onDone when addServer rejects (e.g. wrong password)", async () => {
      const addServer = vi.fn().mockRejectedValue(new Error("Invalid username or password."));
      const { onDone } = renderAddSourceView({ addServer });

      fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "My Server" } });
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: "https://brain.example.com" } });
      fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
      fireEvent.click(screen.getByRole("button", { name: /add server|connect/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/invalid username or password/i);
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe("folder path", () => {
    it("prefills the label from the chosen folder's last path segment, then addFolder + onDone on submit", async () => {
      pickFolderDialogMock.mockResolvedValue("/Users/x/notes");
      const addFolder = vi.fn().mockResolvedValue(undefined);
      const { onDone } = renderAddSourceView({ addFolder });

      fireEvent.click(screen.getByRole("tab", { name: /folder/i }));
      fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

      const labelInput = await screen.findByLabelText(/label/i);
      expect(labelInput).toHaveValue("notes");

      fireEvent.click(screen.getByRole("button", { name: /add folder/i }));

      await waitFor(() => expect(addFolder).toHaveBeenCalledWith("notes", "/Users/x/notes"));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    });

    it("does nothing when the folder dialog is cancelled", async () => {
      pickFolderDialogMock.mockResolvedValue(null);
      const addFolder = vi.fn();
      const { onDone } = renderAddSourceView({ addFolder });

      fireEvent.click(screen.getByRole("tab", { name: /folder/i }));
      fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

      await waitFor(() => expect(pickFolderDialogMock).toHaveBeenCalledTimes(1));
      expect(addFolder).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/label/i)).not.toBeInTheDocument();
    });

    it("lets the prefilled label be edited before submitting", async () => {
      pickFolderDialogMock.mockResolvedValue("/Users/x/notes");
      const addFolder = vi.fn().mockResolvedValue(undefined);
      renderAddSourceView({ addFolder });

      fireEvent.click(screen.getByRole("tab", { name: /folder/i }));
      fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
      const labelInput = await screen.findByLabelText(/label/i);
      fireEvent.change(labelInput, { target: { value: "Personal Notes" } });
      fireEvent.click(screen.getByRole("button", { name: /add folder/i }));

      await waitFor(() => expect(addFolder).toHaveBeenCalledWith("Personal Notes", "/Users/x/notes"));
    });
  });
});
