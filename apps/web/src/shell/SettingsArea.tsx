/** Local view-state toggle for Settings (API Keys / Audit Log) — rendered in the
 *  main slot in place of the editor while Settings is open. There is no
 *  react-router in this app; `AppRoot` mounts this once (on first open) and keeps
 *  it mounted behind a CSS toggle afterwards rather than unmounting it on close,
 *  so `open` flipping to `false` is what has to clear any sensitive transient
 *  state (see `KeysView`'s `active` prop) — an eventual unmount is not
 *  guaranteed to happen at all. */

import { useState } from "react";
import { AuditView } from "../settings/AuditView";
import { KeysView } from "../settings/KeysView";
import { ThemeView } from "../settings/ThemeView";
import styles from "./SettingsArea.module.css";

type SettingsTab = "keys" | "audit" | "appearance";

export interface SettingsAreaProps {
  /** Whether Settings is the thing currently shown in the main slot. False
   *  while kept mounted-but-hidden (see the module doc comment above) — this is
   *  what tells `KeysView` to clear a freshly shown key secret. */
  open: boolean;
  onClose: () => void;
}

export function SettingsArea({ open, onClose }: SettingsAreaProps) {
  const [tab, setTab] = useState<SettingsTab>("keys");

  return (
    <div className={styles.area}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "keys"}
            className={tab === "keys" ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab("keys")}
          >
            API Keys
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "audit"}
            className={tab === "audit" ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab("audit")}
          >
            Audit Log
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "appearance"}
            className={tab === "appearance" ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab("appearance")}
          >
            Appearance
          </button>
        </div>

        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <div className={styles.content}>
        <div className={tab === "keys" ? undefined : styles.hidden}>
          <KeysView active={open && tab === "keys"} />
        </div>
        <div className={tab === "audit" ? undefined : styles.hidden}>
          <AuditView />
        </div>
        <div className={tab === "appearance" ? undefined : styles.hidden}>
          <ThemeView />
        </div>
      </div>
    </div>
  );
}
