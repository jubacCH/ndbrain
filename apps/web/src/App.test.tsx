import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

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
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { notes: [] }));
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "ndBrain" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/welcome, back/i)).toBeInTheDocument());
  });
});
