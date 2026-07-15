import { describe, expect, it, vi } from "vitest";
import { cursorCharLeft, cursorCharRight, deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { GFM, Strikethrough } from "@lezer/markdown";
import { buildDecorations, livePreviewPlugin, mermaidBlockDecorations } from "./decorations";
import { BLOCK_LINE_CLASS, MARK_CLASS, WIDGET_CLASS, headingLineClass } from "./marks";
import { MermaidWidget } from "./mermaid";
import { mermaidEditorHandler } from "./mermaidEditor";
import { TaskCheckboxWidget } from "./tasklist";

/** Mounts a real `EditorView` (jsdom `parent` is enough, matching
 *  `extensions.test.ts`'s own `mountView` convention) wired with the real
 *  live-preview extensions - `livePreviewPlugin` + `mermaidBlockDecorations`
 *  directly, rather than going through `extensions.ts`'s `rawCompartment`
 *  wrapper, since that module is out of this fix's scope. Detached-state
 *  tests (`EditorState.create` with no view) can't catch either Finding 1
 *  (atomic ranges only affect a mounted view's cursor/delete commands) or
 *  Finding 3/4 (both are about what a mounted view's DOM does across
 *  updates) - see the Plan 7 whole-branch review's T6 finding, which is
 *  exactly this class of bug. */
function mountView(doc: string, extraExtensions: Extension[] = []): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] }), livePreviewPlugin, mermaidBlockDecorations, ...extraExtensions],
    }),
  });
}

/** Markdown extension used by these tests. Plain `markdown()` only parses
 *  CommonMark - `~~strike~~` is a GFM extension of `@lezer/markdown` and
 *  needs to be enabled explicitly, or its `Strikethrough` node never appears
 *  in the syntax tree at all (verified live against @lezer/markdown@1.7.1). */
const markdownWithGfm = markdown({ extensions: [Strikethrough] });

/** Block constructs (headings, lists, quotes, rules) are plain CommonMark -
 *  no GFM extension needed to parse them. */
const markdownPlain = markdown();

/** GFM task lists (`- [ ]`/`- [x]`) only produce a `Task`/`TaskMarker` node
 *  when the full `GFM` extension array is enabled (verified live - see
 *  marks.ts's doc comment). */
const markdownWithTasks = markdown({ extensions: [GFM] });

interface DecoRecord {
  from: number;
  to: number;
  /** The decoration's CSS class for a mark or line decoration, or undefined
   *  for a marker-hiding replace. */
  class: string | undefined;
  isReplace: boolean;
  /** True for `Decoration.line` (a zero-width point at the line start). */
  isLine: boolean;
  /** For a widget-backed replace, the rendered widget's tag/class/text. */
  widget: { tag: string; class: string; text: string } | undefined;
}

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownWithGfm] });
}

function plainStateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownPlain] });
}

function taskStateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownWithTasks] });
}

/** Flattens a DecorationSet into plain records sorted by position.
 *  `RangeSet.between` doesn't guarantee simple from-ascending callback order
 *  once ranges nest across its internal layers (verified live), so results
 *  are normalized here for deterministic assertions - the actual DOM/view
 *  rendering CodeMirror does from a DecorationSet is unaffected by that. */
function collect(set: DecorationSet, docLength: number): DecoRecord[] {
  const records: DecoRecord[] = [];
  set.between(0, docLength, (from, to, deco) => {
    const widget = deco.spec.widget;
    records.push({
      from,
      to,
      class: deco.spec.class,
      isReplace: deco.spec.widget === undefined && deco.spec.class === undefined,
      isLine: from === to && deco.spec.class !== undefined,
      widget: widget
        ? {
            tag: widget.toDOM().tagName.toLowerCase(),
            class: widget.toDOM().className,
            text: widget.toDOM().textContent ?? "",
          }
        : undefined,
    });
  });
  return records.sort((a, b) => a.from - b.from || a.to - b.to);
}

describe("buildDecorations", () => {
  it("hides the two ** markers and marks the content as bold, without changing the doc", () => {
    const doc = "**bold**";
    const state = stateFor(doc);

    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);
    const records = collect(decorations, doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 6, class: MARK_CLASS.bold, isReplace: false, isLine: false },
      { from: 6, to: 8, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(0, 2)).toBe("**");
    expect(doc.slice(2, 6)).toBe("bold");
    expect(doc.slice(6, 8)).toBe("**");
    expect(state.doc.toString()).toBe("**bold**");
  });

  it("hides the two * markers and marks the content as italic", () => {
    const doc = "*i*";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true, isLine: false },
      { from: 1, to: 2, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 2, to: 3, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("*i*");
  });

  it("hides the two ~~ markers and marks the content as strikethrough", () => {
    const doc = "~~s~~";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 3, class: MARK_CLASS.strike, isReplace: false, isLine: false },
      { from: 3, to: 5, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("~~s~~");
  });

  it("hides the two ` markers and marks the content as inline code", () => {
    const doc = "`c`";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true, isLine: false },
      { from: 1, to: 2, class: MARK_CLASS.inlineCode, isReplace: false, isLine: false },
      { from: 2, to: 3, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("`c`");
  });

  it("nests bold over the whole span and italic over just the nested content", () => {
    const doc = "**a *b* c**";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 9, class: MARK_CLASS.bold, isReplace: false, isLine: false },
      { from: 4, to: 5, class: undefined, isReplace: true, isLine: false },
      { from: 5, to: 6, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 6, to: 7, class: undefined, isReplace: true, isLine: false },
      { from: 9, to: 11, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(2, 9)).toBe("a *b* c");
    expect(doc.slice(5, 6)).toBe("b");
    expect(state.doc.toString()).toBe("**a *b* c**");
  });

  it("only decorates nodes overlapping the given ranges", () => {
    const doc = "**bold** *i*";
    const state = stateFor(doc);

    // Restrict to the italic span only (from the space before it onward).
    const records = collect(buildDecorations(state, [{ from: 9, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 9, to: 10, class: undefined, isReplace: true, isLine: false },
      { from: 10, to: 11, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 11, to: 12, class: undefined, isReplace: true, isLine: false },
    ]);
  });
});

describe("buildDecorations - block constructs", () => {
  it("hides the # marker and its trailing space, and lines the heading as h1", () => {
    const doc = "# Titel";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: headingLineClass(1), isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("# Titel");
  });

  it("hides the ###### marker and lines the heading as h6", () => {
    const doc = "###### h6";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: headingLineClass(6), isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 7, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("###### h6");
  });

  it("hides the > marker and its trailing space, and lines the paragraph as a quote", () => {
    const doc = "> zitat";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: BLOCK_LINE_CLASS.quote, isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("> zitat");
  });

  it("replaces the - marker of a bullet list item with a widget, item text untouched", () => {
    const doc = "- item";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 1,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "span", class: WIDGET_CLASS.listMarker, text: "•" },
      },
    ]);
    expect(doc.slice(2)).toBe("item");
    expect(state.doc.toString()).toBe("- item");
  });

  it("replaces the 1. marker of an ordered list item with a widget, preserving the number", () => {
    const doc = "1. item";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 2,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "span", class: WIDGET_CLASS.listMarker, text: "1." },
      },
    ]);
    expect(doc.slice(3)).toBe("item");
    expect(state.doc.toString()).toBe("1. item");
  });

  it("replaces a horizontal rule line with an <hr> widget", () => {
    const doc = "---";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 3,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "hr", class: WIDGET_CLASS.hr, text: "" },
      },
    ]);
    expect(state.doc.toString()).toBe("---");
  });
});

describe("buildDecorations - links", () => {
  it("hides the [ ] ( url ) marks and marks the visible text as a link", () => {
    const doc = "[t](http://x)";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true, isLine: false },
      { from: 1, to: 2, class: MARK_CLASS.link, isReplace: false, isLine: false },
      { from: 2, to: 13, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(1, 2)).toBe("t");
    expect(state.doc.toString()).toBe("[t](http://x)");
  });

  it("carries the URL as a data-href attribute on the link mark", () => {
    const doc = "[t](http://x)";
    const state = plainStateFor(doc);
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);

    let href: string | undefined;
    decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.class === MARK_CLASS.link) href = deco.spec.attributes?.["data-href"];
    });

    expect(href).toBe("http://x");
  });
});

describe("buildDecorations - wikilinks", () => {
  it("hides [[ ]] and marks the target text as a wikilink", () => {
    const doc = "before [[Note]] after";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 7, to: 9, class: undefined, isReplace: true, isLine: false },
      { from: 9, to: 13, class: MARK_CLASS.wikilink, isReplace: false, isLine: false },
      { from: 13, to: 15, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(9, 13)).toBe("Note");
    expect(state.doc.toString()).toBe(doc);
  });

  it("does not let the wikilink's inner shortcut-reference Link node add extra decorations", () => {
    // `[[Note]]` parses as a shortcut-reference `Link` node covering
    // "[Note]" (verified live - it has no `URL` child, unlike a real
    // `[text](url)` link) - buildDecorations must skip that node so it
    // doesn't collide with the wikilink's own hide/mark pieces.
    const doc = "[[Note]]";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 6, class: MARK_CLASS.wikilink, isReplace: false, isLine: false },
      { from: 6, to: 8, class: undefined, isReplace: true, isLine: false },
    ]);
  });

  it("carries the target as a data-target attribute on the wikilink mark", () => {
    const doc = "[[Note]]";
    const state = plainStateFor(doc);
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);

    let target: string | undefined;
    decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.class === MARK_CLASS.wikilink) target = deco.spec.attributes?.["data-target"];
    });

    expect(target).toBe("Note");
  });
});

describe("buildDecorations - task checkboxes", () => {
  function checkboxWidgets(doc: string): TaskCheckboxWidget[] {
    const state = taskStateFor(doc);
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);
    const widgets: TaskCheckboxWidget[] = [];
    decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.widget instanceof TaskCheckboxWidget) widgets.push(deco.spec.widget);
    });
    return widgets;
  }

  it("replaces the TaskMarker of an unchecked item with an unchecked checkbox widget", () => {
    const [widget] = checkboxWidgets("- [ ] todo");

    expect(widget).toBeDefined();
    expect(widget.checked).toBe(false);
    expect(widget.from).toBe(2);
    expect(widget.to).toBe(5);
  });

  it("replaces the TaskMarker of a checked item with a checked checkbox widget", () => {
    const [widget] = checkboxWidgets("- [x] done");

    expect(widget.checked).toBe(true);
  });
});

describe("buildDecorations - mermaid fences", () => {
  function mermaidWidgets(doc: string): { from: number; to: number; widget: MermaidWidget }[] {
    const state = plainStateFor(doc);
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);
    const found: { from: number; to: number; widget: MermaidWidget }[] = [];
    decorations.between(0, doc.length, (from, to, deco) => {
      if (deco.spec.widget instanceof MermaidWidget) found.push({ from, to, widget: deco.spec.widget });
    });
    return found;
  }

  it("replaces a ```mermaid fence with a block MermaidWidget over the whole fence, doc untouched", () => {
    const doc = "```mermaid\ngraph TD\nA-->B\n```";
    const state = plainStateFor(doc);
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);

    const [entry] = mermaidWidgets(doc);
    expect(entry).toBeDefined();
    expect(entry.from).toBe(0);
    expect(entry.to).toBe(doc.length);
    expect(entry.widget.code).toBe("graph TD\nA-->B");

    let sawBlock = false;
    decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.widget instanceof MermaidWidget) sawBlock = deco.spec.block === true;
    });
    expect(sawBlock).toBe(true);
    expect(state.doc.toString()).toBe(doc);
  });

  it("does not create a MermaidWidget for a ```js fence", () => {
    const doc = "```js\nconst a = 1;\n```";

    expect(mermaidWidgets(doc)).toEqual([]);
  });

  it("does not create a MermaidWidget for a fence with no info string", () => {
    const doc = "```\nplain code\n```";

    expect(mermaidWidgets(doc)).toEqual([]);
  });

  it("is case-sensitive: ```Mermaid (capitalized) is left as plain fenced code", () => {
    const doc = "```Mermaid\ngraph TD\nA-->B\n```";

    expect(mermaidWidgets(doc)).toEqual([]);
  });

  it("gives the widget only the CodeText content, no document position (Finding 3 fix)", () => {
    // The widget used to carry the CodeText range's from/to so `eq()` could
    // compare it - which made `eq()` false (and the diagram DOM discarded and
    // re-rendered) on every edit that merely shifted the fence's position
    // without changing its content. It's position-less now: only `code`
    // (verified below in the "mermaidBlockDecorations - flicker prevention"
    // mounted-view tests, which exercise the actual DOM-reuse behavior this
    // enables).
    const doc = "```mermaid\ngraph TD\nA-->B\n```";

    const [{ widget }] = mermaidWidgets(doc);

    expect(widget.code).toBe("graph TD\nA-->B");
    expect((widget as unknown as { from?: number }).from).toBeUndefined();
    expect((widget as unknown as { to?: number }).to).toBeUndefined();
  });

  it("wires the widget's onEdit to the mermaidEditorHandler facet, so a click reaches the live handler", () => {
    const doc = "```mermaid\ngraph TD\nA-->B\n```";
    const codeTextFrom = doc.indexOf("graph TD");
    const codeTextTo = codeTextFrom + "graph TD\nA-->B".length;
    const handler = vi.fn();
    const state = EditorState.create({ doc, extensions: [markdownPlain, mermaidEditorHandler.of(handler)] });
    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);

    let widget: MermaidWidget | undefined;
    decorations.between(0, doc.length, (_from, _to, deco) => {
      if (deco.spec.widget instanceof MermaidWidget) widget = deco.spec.widget;
    });

    widget!.onEdit({ code: widget!.code, from: codeTextFrom, to: codeTextTo });

    expect(handler).toHaveBeenCalledWith({ code: "graph TD\nA-->B", from: codeTextFrom, to: codeTextTo });
  });
});

describe("livePreviewPlugin - atomic hidden markers (Finding 1, mounted view)", () => {
  // These exercise the real `deleteCharBackward`/`cursorCharLeft` commands
  // from `@codemirror/commands` against a mounted `EditorView` - a detached
  // `EditorState` has no `EditorView.atomicRanges` facet consumer at all
  // (only `view.moveByChar`/the delete commands' `skipAtomic` helper consult
  // it), so this bug is invisible to state-only tests (the T6-style mount
  // gap the Plan 7 whole-branch review flagged).

  it("never lets Backspace split the hidden closing ** of **bold** in two", () => {
    const view = mountView("**bold**");
    view.dispatch({ selection: { anchor: 8 } }); // doc end, right after the hidden closing "**"

    deleteCharBackward(view);

    // Verified live (@codemirror/commands@6.10.4's `skipAtomic`): landing
    // exactly on an atomic range's own end is not "inside" it, but the
    // computed one-char-back delete target (7) *is* strictly inside the
    // hidden closing marker's atomic range [6, 8) - so the whole atomic unit
    // is consumed together. The one outcome that must never happen is the
    // pre-fix bug: corrupting the doc to the unbalanced "**bold*".
    expect(view.state.doc.toString()).not.toBe("**bold*");
    expect(view.state.doc.toString()).toBe("**bold");
    view.destroy();
  });

  it("cursorCharLeft jumps clean over the hidden closing ** in a single motion", () => {
    const view = mountView("**bold**");
    view.dispatch({ selection: { anchor: 8 } });

    cursorCharLeft(view);

    // Without atomicRanges this would land at 7 (inside the hidden marker).
    expect(view.state.selection.main.head).toBe(6);
    view.destroy();
  });

  it("never lets Backspace split the hidden closing ]] of a wikilink in two", () => {
    const doc = "[[Note]]";
    const view = mountView(doc);
    view.dispatch({ selection: { anchor: doc.length } }); // doc end, right after the hidden "]]"

    deleteCharBackward(view);

    expect(view.state.doc.toString()).not.toBe("[[Note]");
    expect(view.state.doc.toString()).toBe("[[Note");
    view.destroy();
  });

  it("cursorCharLeft jumps clean over the hidden closing ]] of a wikilink", () => {
    const doc = "[[Note]]";
    const view = mountView(doc);
    view.dispatch({ selection: { anchor: doc.length } });

    cursorCharLeft(view);

    expect(view.state.selection.main.head).toBe(doc.length - 2);
    view.destroy();
  });

  it("makes a MULTI-char ordered-list marker (1.) atomic - Backspace can't split it", () => {
    // Follow-up to the initial Finding-1 fix: visible-widget replacements are
    // now atomic too, because the multi-char ones (`1.`, `---`, `[ ]`) are
    // just as splittable as a hidden marker. Without this, Backspace after
    // `1.` yielded the corrupted `1 item`.
    const view = mountView("1. item");
    view.dispatch({ selection: { anchor: 2 } }); // right after the "1." marker

    deleteCharBackward(view);

    // The whole "1." atomic range is consumed, not split into "1 item".
    expect(view.state.doc.toString()).toBe(" item");
    view.destroy();
  });

  it("makes the --- horizontal-rule marker atomic - deleteForward can't split it", () => {
    const view = mountView("---");
    view.dispatch({ selection: { anchor: 0 } });

    deleteCharForward(view);

    // Whole rule gone, not the split "--" that stops being an HR.
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("makes the [ ] task-checkbox marker atomic - Backspace can't corrupt it", () => {
    const view = mountView("- [ ] todo");
    // Position right after the "]" of the checkbox marker "[ ]" (which spans
    // the 3 chars after "- ").
    view.dispatch({ selection: { anchor: 5 } });

    deleteCharBackward(view);

    // The whole "[ ]" atomic range is consumed (leaving "- " + " todo"),
    // never the corrupted "[  todo".
    expect(view.state.doc.toString()).toBe("-  todo");
    view.destroy();
  });

  it("cursorCharLeft jumps clean over the whole [ ] task-checkbox marker", () => {
    const view = mountView("- [ ] todo");
    view.dispatch({ selection: { anchor: 5 } }); // just after "]"

    cursorCharLeft(view);

    // Without atomicRanges this would land at 4 (inside "[ ]"); with it, the
    // cursor jumps clean to the marker's start at 2.
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });

  it("also makes a ```mermaid block replacement atomic: cursor motion jumps clean over the whole fence", () => {
    const doc = "before\n```mermaid\ngraph TD\nA-->B\n```\nafter";
    const fenceStart = doc.indexOf("```mermaid");
    const fenceEnd = doc.indexOf("```\nafter") + 3;
    const view = mountView(doc);
    view.dispatch({ selection: { anchor: fenceStart } });

    cursorCharRight(view);

    expect(view.state.selection.main.head).toBe(fenceEnd);
    view.destroy();
  });

  it("also makes a ```mermaid block replacement atomic: delete removes the whole fence in one go", () => {
    const doc = "before\n```mermaid\ngraph TD\nA-->B\n```\nafter";
    const fenceStart = doc.indexOf("```mermaid");
    const view = mountView(doc);
    view.dispatch({ selection: { anchor: fenceStart } });

    deleteCharForward(view);

    expect(view.state.doc.toString()).toBe("before\n\nafter");
    view.destroy();
  });
});

describe("mermaidBlockDecorations - flicker prevention (Finding 3, mounted view)", () => {
  const fenceDoc = "line above\n\n```mermaid\ngraph TD\nA-->B\n```\n";

  it("keeps the same rendered DOM node across an edit above the fence (no discard/re-render)", () => {
    const view = mountView(fenceDoc);
    const before = view.dom.querySelector(".cm-lp-mermaid");
    expect(before).not.toBeNull();

    view.dispatch({ changes: { from: 0, to: 0, insert: "X" } });

    const after = view.dom.querySelector(".cm-lp-mermaid");
    expect(after).toBe(before);
    view.destroy();
  });

  it("resolves the fence's CURRENT (shifted) CodeText range on click after an edit above it", () => {
    const handlerCalls: { code: string; from: number; to: number }[] = [];
    const view = mountView(fenceDoc, [mermaidEditorHandler.of((request) => handlerCalls.push(request))]);

    view.dispatch({ changes: { from: 0, to: 0, insert: "XYZ" } });
    const el = view.dom.querySelector(".cm-lp-mermaid")!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const newDoc = view.state.doc.toString();
    const codeTextFrom = newDoc.indexOf("graph TD");
    const codeTextTo = codeTextFrom + "graph TD\nA-->B".length;
    expect(handlerCalls).toEqual([{ code: "graph TD\nA-->B", from: codeTextFrom, to: codeTextTo }]);
    view.destroy();
  });
});

describe("livePreviewPlugin / mermaidBlockDecorations - async syntax-tree rebuild (Finding 4, mounted view)", () => {
  // `@codemirror/language`'s `Language.state` field only parses the first
  // ~3000 characters of a document synchronously at creation (verified live
  // - `LanguageState.init`'s `Work.InitViewport` constant); anything beyond
  // that is filled in by a background `requestIdleCallback` worker that
  // eventually dispatches a transaction with neither `docChanged` nor
  // `viewportChanged` set (`view.dispatch({ effects: Language.setState.of(...) })`
  // in `parseWorker`'s `work()`). `forceParsing` (from `@codemirror/language`)
  // synchronously drives that same background work and dispatches the
  // resulting update, without changing the document - the same shape of
  // transaction a real large document's async parse produces, letting this
  // be provoked deterministically instead of racing a real idle callback.
  const PAD = "x".repeat(4000);

  it("decorates a ```mermaid fence beyond the initial sync-parsed range only once the tree updates", () => {
    const doc = `${PAD}\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n`;
    const view = mountView(doc);

    // Not yet decorated: the fence sits beyond `Language.state`'s initial
    // synchronous parse window, so its syntax subtree doesn't exist yet.
    expect(view.dom.querySelector(".cm-lp-mermaid")).toBeNull();
    expect(view.dom.textContent).toContain("graph TD");

    const ok = forceParsing(view, doc.length, 2000);
    expect(ok).toBe(true);

    expect(view.dom.querySelector(".cm-lp-mermaid")).not.toBeNull();
    expect(view.dom.textContent).not.toContain("```mermaid");
    view.destroy();
  });

  it("hides a **bold** marker beyond the initial sync-parsed range only once the tree updates", () => {
    const doc = `${PAD}\n\n**bold**\n`;
    const view = mountView(doc);

    expect(view.dom.textContent).toContain("**bold**");

    const ok = forceParsing(view, doc.length, 2000);
    expect(ok).toBe(true);

    expect(view.dom.textContent).not.toContain("**bold**");
    expect(view.dom.textContent).toContain("bold");
    view.destroy();
  });
});
