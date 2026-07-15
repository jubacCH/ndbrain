import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeView } from "./ThemeView";
import type { UseThemeResult } from "../theme/useTheme";

function makeState(overrides: Partial<UseThemeResult> = {}): UseThemeResult {
  return {
    preference: null,
    themeId: "graphite-dark",
    resolvedTheme: "dark",
    themes: [
      { id: "graphite-dark", label: "Graphite Dark", kind: "dark" },
      { id: "duplex", label: "Duplex", kind: "light" },
    ],
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
    ...overrides,
  };
}

describe("ThemeView", () => {
  it("lists every registered theme plus a Follow-system option", () => {
    render(<ThemeView themeState={makeState()} />);
    expect(screen.getByRole("radio", { name: /follow system/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /graphite dark/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /duplex/i })).toBeInTheDocument();
  });

  it("marks Follow-system when there is no override", () => {
    render(<ThemeView themeState={makeState({ preference: null })} />);
    expect(screen.getByRole("radio", { name: /follow system/i })).toBeChecked();
  });

  it("marks the active theme when one is picked", () => {
    render(<ThemeView themeState={makeState({ preference: "duplex" })} />);
    expect(screen.getByRole("radio", { name: /duplex/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /follow system/i })).not.toBeChecked();
  });

  it("calls setTheme with the id when a theme is picked, and null for Follow system", () => {
    const setTheme = vi.fn();
    render(<ThemeView themeState={makeState({ setTheme })} />);

    fireEvent.click(screen.getByRole("radio", { name: /duplex/i }));
    expect(setTheme).toHaveBeenCalledWith("duplex");

    fireEvent.click(screen.getByRole("radio", { name: /follow system/i }));
    expect(setTheme).toHaveBeenCalledWith(null);
  });
});
