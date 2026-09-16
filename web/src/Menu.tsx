/**
 * A small pop-up menu behind a button: the account menu in the header.
 *
 * Built to the ARIA menu-button pattern, because that is what a keyboard user
 * already knows from every desktop application: the button says it has a menu
 * and whether it is open, opening moves focus onto the first entry, the arrow
 * keys walk the entries, Escape closes and hands focus back to the button, and
 * a click anywhere else closes it without a word.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const all = entries();
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
        setOpen(false);
        break;
      default:
    }
  };

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
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
