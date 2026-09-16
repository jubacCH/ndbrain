/**
 * The header bar above every view.
 *
 * Left, where you are: the view's title and a line of real numbers under it —
 * "118 notes · 323 connections", never a slogan. Right, what you can do from
 * anywhere: search, the theme, the account.
 *
 * The search field is not a second search. It is a button shaped like a field
 * that opens the ⌘K palette, the one way to jump to a note; a field here with
 * its own results would be a third place to find something, answering a
 * question the palette and the search view already answer.
 */

import type { ReactNode } from 'react';

import { copy } from './copy';
import { MenuButton, type MenuItem } from './Menu';
import { MenuIcon, MoonIcon, SearchIcon, SunIcon, UserIcon } from './icons';

export function Topbar({
  title,
  subtitle,
  extras,
  dark,
  accountName,
  accountItems,
  onMenu,
  onSearch,
  onToggleTheme,
}: {
  title: string;
  subtitle: string;
  /** View-specific status beside the title: the save state, a shared-note pill. */
  extras?: ReactNode;
  /** Whether the dark theme is the one on screen, whatever chose it. */
  dark: boolean;
  accountName: string;
  accountItems: MenuItem[];
  /** Opens the sidebar drawer; the button exists on narrow screens only. */
  onMenu: () => void;
  onSearch: () => void;
  onToggleTheme: () => void;
}): React.JSX.Element {
  return (
    <header className="topbar">
      <button type="button" className="iconbtn bar-menu" onClick={onMenu} aria-label={copy.nav.menu}>
        <MenuIcon />
      </button>

      <div className="topbar-title">
        <h1 className="cur">{title}</h1>
        {subtitle !== '' && <p className="topbar-sub">{subtitle}</p>}
      </div>

      {extras !== undefined && <div className="topbar-extras">{extras}</div>}

      <button
        type="button"
        className="topsearch"
        onClick={onSearch}
        aria-label={copy.shell.searchLabel}
        aria-keyshortcuts="Meta+K Control+K"
      >
        <SearchIcon size={17} />
        <span className="topsearch-ph">{copy.shell.searchPlaceholder}</span>
        <kbd>⌘ K</kbd>
      </button>

      <button
        type="button"
        className="iconbtn"
        onClick={onToggleTheme}
        aria-label={dark ? copy.shell.lightTheme : copy.shell.darkTheme}
        title={dark ? copy.shell.lightTheme : copy.shell.darkTheme}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </button>

      <MenuButton
        label={copy.shell.account}
        icon={<UserIcon />}
        header={copy.shell.signedInAs(accountName)}
        items={accountItems}
      />
    </header>
  );
}
