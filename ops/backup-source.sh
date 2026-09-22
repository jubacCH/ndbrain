#!/usr/bin/env bash
#
# Was der Backup-Puller auf diesem Container lesen darf, und sonst nichts.
#
# Das Backup zieht, statt dass ndBrain schiebt: ein kompromittierter oder
# fehlerhafter ndBrain-Container soll das Backup nicht mitreissen können. Damit
# das etwas wert ist, darf der Weg, den das Ziel benutzt, hier nur lesen —
# sonst wäre die Richtung blosse Kosmetik. Deshalb geht der Aufruf durch diese
# Liste statt an eine Shell.
#
# Zwei Dinge sind erlaubt:
#
#   vaults        die Notizen samt .git, also einschliesslich aller Versionen
#   db-snapshot   den jüngsten konsistenten Stand der Datenbank
#
# Beides schreibt nur nach stdout. Es gibt hier keinen Fall, der etwas anlegt,
# ändert oder löscht.

set -euo pipefail

VAULTS=${NDBRAIN_VAULTS:-/srv/ndbrain/vaults}
BACKUP=${NDBRAIN_BACKUP:-/srv/ndbrain/backup}

case "${1:-}" in
  vaults)
    # Das .git jedes Vaults geht mit: darin steckt die ganze Historie, und
    # damit ist dieser eine Strom ein vollständiges Backup, kein Tagesstand.
    exec tar -C "$(dirname "$VAULTS")" -czf - "$(basename "$VAULTS")"
    ;;

  db-snapshot)
    newest=$(ls -1t "$BACKUP"/ndbrain-*.db 2>/dev/null | head -1)
    if [ -z "$newest" ]; then
      echo "kein Stand vorhanden" >&2
      exit 1
    fi
    exec gzip -c "$newest"
    ;;

  db-name)
    # Wie der jüngste Stand heisst, damit das Ziel ihn nicht neu datieren muss
    # und ein ausgefallener naechtlicher Lauf am Namen sichtbar bleibt.
    newest=$(ls -1t "$BACKUP"/ndbrain-*.db 2>/dev/null | head -1)
    [ -n "$newest" ] && basename "$newest" || exit 1
    ;;

  *)
    echo "nicht erlaubt" >&2
    exit 1
    ;;
esac
