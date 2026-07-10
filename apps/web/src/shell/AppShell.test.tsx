import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

function stubMatchMedia(initialMatches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: initialMatches,
      media: "(prefers-color-scheme: dark)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders the sidebar, main, and (when provided) right panel slots", () => {
    stubMatchMedia(false);
    render(
      <AppShell
        sidebar={<div data-testid="sidebar-slot">tree</div>}
        main={<div data-testid="main-slot">editor</div>}
        rightPanel={<div data-testid="right-slot">backlinks</div>}
        onLogout={() => {}}
      />,
    );

    expect(screen.getByTestId("sidebar-slot")).toBeInTheDocument();
    expect(screen.getByTestId("main-slot")).toBeInTheDocument();
    expect(screen.getByTestId("right-slot")).toBeInTheDocument();
  });

  it("omits the right panel region entirely when no rightPanel is passed", () => {
    stubMatchMedia(false);
    render(<AppShell sidebar={<div />} main={<div />} onLogout={() => {}} />);

    expect(screen.queryByLabelText("Panels")).not.toBeInTheDocument();
  });

  it("shows the username and calls onLogout when Log out is clicked", () => {
    stubMatchMedia(false);
    const onLogout = vi.fn();
    render(<AppShell sidebar={<div />} main={<div />} username="julian" onLogout={onLogout} />);

    expect(screen.getByText("julian")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Log out"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("calls onSearchClick and onSettingsClick when their triggers are clicked", () => {
    stubMatchMedia(false);
    const onSearchClick = vi.fn();
    const onSettingsClick = vi.fn();
    render(
      <AppShell
        sidebar={<div />}
        main={<div />}
        onLogout={() => {}}
        onSearchClick={onSearchClick}
        onSettingsClick={onSettingsClick}
      />,
    );

    fireEvent.click(screen.getByText("Search…"));
    fireEvent.click(screen.getByText("Settings"));

    expect(onSearchClick).toHaveBeenCalledTimes(1);
    expect(onSettingsClick).toHaveBeenCalledTimes(1);
  });

  it("the theme toggle flips document.documentElement's data-theme attribute", () => {
    stubMatchMedia(false);
    render(<AppShell sidebar={<div />} main={<div />} onLogout={() => {}} />);

    const toggle = screen.getByRole("button", { name: /switch to dark theme/i });
    fireEvent.click(toggle);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });
});
