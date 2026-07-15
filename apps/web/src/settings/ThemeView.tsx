/** Theme picker. Driven entirely by the registry exposed from `useTheme`, so a
 *  theme added in `theme/themes.ts` (+ its `[data-theme]` block in index.css)
 *  shows up here with no change to this file. "Follow system" clears the
 *  explicit override and tracks the OS preference. */

import { useTheme, type UseThemeResult } from "../theme/useTheme";
import styles from "./Settings.module.css";

export interface ThemeViewProps {
  /** Injectable for tests; defaults to the real `useTheme` hook. */
  themeState?: UseThemeResult;
}

export function ThemeView({ themeState }: ThemeViewProps) {
  // Always call the hook (rules-of-hooks); `themeState` is a test-only override.
  const live = useTheme();
  const { preference, themes, setTheme } = themeState ?? live;

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelHeading}>Appearance</h3>
      <p className={styles.panelHint}>
        Pick a colour theme. Each theme is a palette of design tokens — new ones can be added in a single
        stylesheet block.
      </p>

      <div className={styles.themeGrid} role="radiogroup" aria-label="Colour theme">
        <button
          type="button"
          role="radio"
          aria-checked={preference === null}
          className={preference === null ? `${styles.themeOption} ${styles.themeActive}` : styles.themeOption}
          onClick={() => setTheme(null)}
        >
          <span className={styles.themeName}>Follow system</span>
          <span className={styles.themeMeta}>matches your OS light/dark setting</span>
        </button>

        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={preference === theme.id}
            className={
              preference === theme.id ? `${styles.themeOption} ${styles.themeActive}` : styles.themeOption
            }
            onClick={() => setTheme(theme.id)}
          >
            <span className={styles.themeName}>{theme.label}</span>
            <span className={styles.themeMeta}>{theme.kind}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
