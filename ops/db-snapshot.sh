#!/usr/bin/env bash
#
# Tagesstand der ndBrain-Datenbank.
#
# Die Vaults sichert git, Datei für Datei und mit Historie. Für die Datenbank
# geht das nicht: sie ist keine Textdatei, und sie enthält das Einzige, was
# ndBrain NICHT aus dem Vault wiederherstellen kann — Konten, Sitzungen,
# Agent-Keys, Freigaben und das Bearbeitungsprotokoll. Der Index daneben ist
# ein Cache und könnte neu gebaut werden; er wird trotzdem mitgesichert, weil
# er in derselben Datei liegt.
#
# `.backup` und nicht `cp`: die Datenbank läuft im WAL-Modus, also steht ein
# Teil der jüngsten Schreibvorgänge in einer Nebendatei. Eine Dateikopie
# erwischt einen Zustand zwischen zwei Transaktionen und ist beim Zurückspielen
# wertlos — und das merkt man erst dann. `.backup` fragt SQLite selbst nach
# einem konsistenten Stand, bei laufendem Dienst.

set -euo pipefail

DB=${NDBRAIN_DB:-/srv/ndbrain/index/ndbrain.db}
DEST=${NDBRAIN_BACKUP:-/srv/ndbrain/backup}
KEEP=${NDBRAIN_BACKUP_KEEP:-14}

if [ ! -f "$DB" ]; then
  echo "Datenbank $DB existiert nicht" >&2
  exit 1
fi

mkdir -p "$DEST"
stamp=$(date +%F)
target="$DEST/ndbrain-$stamp.db"

# Erst daneben schreiben, dann umbenennen: ein abgebrochener Lauf hinterlässt
# so keine halbe Datei unter dem Namen, den das Backup als gültig abholt.
tmp="$target.partial"
rm -f "$tmp"
sqlite3 "$DB" ".backup '$tmp'"

# Der Stand muss lesbar sein, sonst sichern wir eine kaputte Datei weiter.
if ! sqlite3 "$tmp" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "Integritätsprüfung des Stands fehlgeschlagen, alter Stand bleibt" >&2
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$target"
chmod 600 "$target"

# Ältere Stände wegräumen, neueste zuerst behalten.
ls -1t "$DEST"/ndbrain-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

echo "Stand $stamp gesichert ($(du -h "$target" | cut -f1)), $(ls -1 "$DEST"/ndbrain-*.db | wc -l) Stände vorhanden"
