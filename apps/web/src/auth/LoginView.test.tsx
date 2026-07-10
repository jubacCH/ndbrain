import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../api/client";
import { AuthContext, type AuthContextValue } from "./useAuth";
import { LoginView } from "./LoginView";

function renderWithAuth(overrides: Partial<AuthContextValue> = {}) {
  const value: AuthContextValue = {
    loading: false,
    authenticated: false,
    username: null,
    token: null,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <AuthContext.Provider value={value}>
      <LoginView />
    </AuthContext.Provider>,
  );
  return value;
}

describe("LoginView", () => {
  it("submits the entered username and password to login()", async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    renderWithAuth({ login });

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "julian" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith("julian", "hunter2"));
  });

  it("shows an error message when login rejects with UnauthorizedError (bad credentials)", async () => {
    const login = vi.fn().mockRejectedValue(new UnauthorizedError("bad_credentials", "invalid login"));
    renderWithAuth({ login });

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "julian" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid username or password/i);
  });

  it("shows a generic error message when login rejects with something unexpected", async () => {
    const login = vi.fn().mockRejectedValue(new Error("network down"));
    renderWithAuth({ login });

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "julian" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/login failed/i);
  });

  it("does not call login when required fields are empty", async () => {
    const login = vi.fn();
    renderWithAuth({ login });

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(login).not.toHaveBeenCalled();
  });
});
