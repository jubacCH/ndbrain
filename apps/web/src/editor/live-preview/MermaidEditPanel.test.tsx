import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { renderMermaid as renderMermaidType } from "./mermaid";

const { renderMermaidMock } = vi.hoisted(() => ({ renderMermaidMock: vi.fn<typeof renderMermaidType>() }));

vi.mock("./mermaid", () => ({ renderMermaid: renderMermaidMock }));

// Explicit ".tsx" extension - see Toolbar.test.tsx's doc comment: on this
// case-insensitive filesystem a bare "./MermaidEditPanel" specifier risks
// resolving ambiguously next to a same-named ".ts" sibling. There is no such
// sibling here, but the convention is kept for any future importer to copy.
import { MermaidEditPanel } from "./MermaidEditPanel.tsx";

describe("<MermaidEditPanel>", () => {
  beforeEach(() => {
    renderMermaidMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    // Unconditional (not just at the end of the debounce test's happy path)
    // so a failed assertion mid-test can never leave fake timers active for
    // the next test - which would otherwise hang any subsequent `waitFor`.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the initial code in the textarea and the initial preview once rendered", async () => {
    renderMermaidMock.mockResolvedValue("<svg>initial</svg>");

    render(
      <MermaidEditPanel code={"graph TD\nA-->B"} onSave={vi.fn()} onClose={vi.fn()} debounceMs={0} />,
    );

    expect(screen.getByLabelText("Mermaid-Code")).toHaveValue("graph TD\nA-->B");
    await waitFor(() => expect(screen.getByTestId("mermaid-edit-preview").innerHTML).toContain("initial"));
    expect(renderMermaidMock).toHaveBeenCalledWith("graph TD\nA-->B", expect.any(String));
  });

  it("debounces the preview re-render while typing: no update before the delay, an update after", async () => {
    vi.useFakeTimers();
    renderMermaidMock.mockResolvedValue("<svg>v1</svg>");

    render(<MermaidEditPanel code="graph TD" onSave={vi.fn()} onClose={vi.fn()} />);

    // Let the initial (mount) debounced render settle first.
    await vi.advanceTimersByTimeAsync(300);
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);

    renderMermaidMock.mockResolvedValue("<svg>v2</svg>");
    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph TD\nA-->B" } });

    // Still only the initial render - the debounce window hasn't elapsed.
    await vi.advanceTimersByTimeAsync(299);
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(renderMermaidMock).toHaveBeenCalledTimes(2);
    expect(renderMermaidMock).toHaveBeenLastCalledWith("graph TD\nA-->B", expect.any(String));
  });

  it("shows an error line instead of crashing when the preview fails to render", async () => {
    renderMermaidMock.mockRejectedValue(new Error("Parse error on line 1"));

    render(<MermaidEditPanel code="not a diagram" onSave={vi.fn()} onClose={vi.fn()} debounceMs={0} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Parse error on line 1"));
    expect(screen.queryByTestId("mermaid-edit-preview")).not.toBeInTheDocument();
  });

  it('"Übernehmen" calls onSave with the current (possibly edited) textarea content', async () => {
    renderMermaidMock.mockResolvedValue("<svg/>");
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<MermaidEditPanel code="graph TD" onSave={onSave} onClose={onClose} debounceMs={0} />);

    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Übernehmen"));

    expect(onSave).toHaveBeenCalledWith("graph LR\nX-->Y");
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Abbrechen" calls onClose without ever calling onSave', async () => {
    renderMermaidMock.mockResolvedValue("<svg/>");
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<MermaidEditPanel code="graph TD" onSave={onSave} onClose={onClose} debounceMs={0} />);

    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Abbrechen"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
