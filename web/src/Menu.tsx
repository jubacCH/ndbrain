/**
 * Small pop-up menus: one behind a button, one at a point.
 *
 * `MenuButton` is the account menu in the header and the actions on an open
 * note beside its save state. `ContextMenu` is the same list of entries opened
 * by a right-click on a row of the tree.
 *
 * Both are built to the ARIA menu pattern, because that is what a keyboard user
 * already knows from every desktop application: opening moves focus onto the
 * first entry, the arrow keys walk the entries, Escape closes and hands focus
 * back where it came from, and a click anywhere else closes it without a word.
 * The walking is written once, in `menuKeys`, so the two cannot drift into
 * behaving differently.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** A destructive entry, drawn in the warning colour. */
  danger?: boolean;
  onSelect: () => void;
}

/**
 * The arrow keys, Home, End, Escape and Tab over a list of `menuitem`s.
 *
 * `close(refocus)` is the one thing the two menus do differently, and it is
 * the argument rather than the behaviour: a button menu hands focus back to its
 * button, a context menu to the row it was opened on.
 */
function menuKeys(
  list: React.RefObject<HTMLDivElement | null>,
  close: (refocus: boolean) => void,
): (event: React.KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (all.length === 0) return;
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        all[(index + 1) % all.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        all[(index - 1 + all.length) % all.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        all[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        all[all.length - 1]?.focus();
        break;
      case 'Tab':
        // Leaving the menu by Tab closes it, as a native menu would.
        close(false);
        break;
      default:
    }
  };
}

/** One entry, drawn the same way wherever the list is. */
function Entry({ item, onChosen }: { item: MenuItem; onChosen: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={item.danger === true ? 'menu-item menu-item-danger' : 'menu-item'}
      onClick={() => {
        onChosen();
        item.onSelect();
      }}
    >
      {item.icon}
      <span>{item.label}</span>
    </button>
  );
}

export function MenuButton({
  label,
  icon,
  items,
  header,
  className,
  align = 'end',
}: {
  /** The button's accessible name, also shown as its tooltip. */
  label: string;
  icon: ReactNode;
  items: MenuItem[];
  /** A line above the entries that is not an entry, such as who is signed in. */
  header?: string;
  className?: string;
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end';
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const entries = (): HTMLButtonElement[] =>
    [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();

    const onPointer = (event: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = menuKeys(list, close);

  return (
    <div className="menubox" ref={box}>
      <button
        ref={button}
        type="button"
        className={className ?? 'iconbtn'}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
      </button>
      {open && (
        <div
          className="menu"
          data-align={align}
          id={id}
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={onKeyDown}
        >
          {header !== undefined && <p className="menu-head">{header}</p>}
          {items.map((item) => (
            <Entry key={item.key} item={item} onChosen={() => close(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The same entries, opened at a point rather than behind a button.
 *
 * A right-click on a row of the tree. It exists because the tree's actions were
 * reachable and not findable: renaming a note is F2 on the row and deleting it
 * is Delete, which is in `aria-keyshortcuts` and in no other place somebody
 * would look. The menu says out loud what the row can do.
 *
 * The browser raises `contextmenu` for the keyboard's own menu key and for
 * Shift+F10 as well as for the right button, and gives coordinates on the
 * focused element in those cases — so one handler serves both and there is no
 * second, keyboard-only path to keep working.
 *
 * Rendered only while it is open: a menu that is in the markup with
 * `display: none` is still in the accessibility tree of some screen readers,
 * announcing entries for a row nobody asked about.
 */
export function ContextMenu({
  at,
  label,
  items,
  onClose,
}: {
  /** Where the pointer was, in client coordinates. */
  at: { x: number; y: number };
  label: string;
  items: MenuItem[];
  /** `true` asks for the focus to go back where the menu was opened from. */
  onClose: (refocus: boolean) => void;
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const [at2, setAt2] = useState(at);

  // Before the paint, so the menu is never seen hanging off the edge and then
  // jumping. `innerWidth` rather than the document's width: this is positioned
  // against the viewport.
  useLayoutEffect(() => {
    const box = list.current;
    if (box === null) return;
    const { width, height } = box.getBoundingClientRect();
    // Zero in jsdom, which has no layout — and then this changes nothing,
    // which is the right answer rather than a guess.
    if (width === 0 && height === 0) return;
    setAt2({
      x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)),
    });
  }, [at]);

  useEffect(() => {
    [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])][0]?.focus();

    const outside = (event: PointerEvent): void => {
      if (list.current !== null && !list.current.contains(event.target as Node)) onClose(false);
    };
    // A scroll under an open menu would leave it pointing at a row that has
    // moved, so it closes rather than follows.
    const away = (): void => onClose(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [onClose]);

  return (
    <div
      className="menu menu-at"
      style={{ left: `${at2.x}px`, top: `${at2.y}px` }}
      role="menu"
      aria-label={label}
      ref={list}
      onKeyDown={menuKeys(list, onClose)}
    >
      {items.map((item) => (
        <Entry key={item.key} item={item} onChosen={() => onClose(false)} />
      ))}
    </div>
  );
}
