import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerUrl, setServerUrl } from "../api/base-url";
import { ServerUrlView } from "./ServerUrlView";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

describe("ServerUrlView", () => {
  afterEach(() => {
    setTauriFlag(undefined);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders nothing in the browser, even without a configured server url", () => {
    setTauriFlag(undefined);
    const { container } = render(<ServerUrlView />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the connect form in Tauri when no server url is configured", () => {
    setTauriFlag(true);
    render(<ServerUrlView />);
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  it("renders nothing in Tauri once a server url is already configured", () => {
    setTauriFlag(true);
    setServerUrl("https://brain.example.com");
    const { container } = render(<ServerUrlView />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a validation error and never calls fetch for a URL missing a scheme", async () => {
    setTauriFlag(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ServerUrlView />);

    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: "brain.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getServerUrl()).toBeNull();
  });

  it("shows a validation error for a non-http(s) scheme", async () => {
    setTauriFlag(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ServerUrlView />);

    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: "ftp://brain.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/http/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an unreachable error when the reachability ping rejects (network error)", async () => {
    setTauriFlag(true);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(<ServerUrlView />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://brain.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach/i);
    expect(getServerUrl()).toBeNull();
  });

  it("treats any HTTP response (even 401) from the ping as reachable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    setTauriFlag(true);
    vi.stubGlobal("fetch", fetchMock);
    const onConnected = vi.fn();
    render(<ServerUrlView onConnected={onConnected} />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://brain.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(getServerUrl()).toBe("https://brain.example.com");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://brain.example.com/api/v1/notes",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("normalizes a trailing slash before pinging and persisting", async () => {
    setTauriFlag(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ServerUrlView />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://brain.example.com/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(() => expect(getServerUrl()).toBe("https://brain.example.com"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://brain.example.com/api/v1/notes",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("hides the form once connected (self-gates without needing a remount)", async () => {
    setTauriFlag(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ServerUrlView />);

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://brain.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("does not render a local-only button when onUseLocalOnly is not passed", () => {
    setTauriFlag(true);
    render(<ServerUrlView />);
    expect(screen.queryByRole("button", { name: /local notes only/i })).not.toBeInTheDocument();
  });

  it("renders a secondary local-only button when onUseLocalOnly is passed, and calls it on click", () => {
    setTauriFlag(true);
    const onUseLocalOnly = vi.fn();
    render(<ServerUrlView onUseLocalOnly={onUseLocalOnly} />);

    const localOnlyButton = screen.getByRole("button", { name: /local notes only/i });
    expect(localOnlyButton).toBeInTheDocument();
    // Must never fire the reachability ping - this is an explicit bypass of it.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fireEvent.click(localOnlyButton);

    expect(onUseLocalOnly).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
