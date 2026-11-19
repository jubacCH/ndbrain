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
#   vaults           die Notizen samt .git, also einschliesslich aller Versionen
#   db-snapshot      den jüngsten konsistenten Stand der Datenbank
#   login-refusals   wie oft die Login-Bremse zuletzt jemanden abgewiesen hat
#
# Beides schreibt nur nach stdout. Es gibt hier keinen Fall, der etwas anlegt,
# ändert oder löscht.

set -euo pipefail

VAULTS=${NDBRAIN_VAULTS:-/srv/ndbrain/vaults}
BACKUP=${NDBRAIN_BACKUP:-/srv/ndbrain/backup}
# Shared with vault-history.sh, which holds it while it commits.
LOCK=${NDBRAIN_VAULTS_LOCK:-/run/lock/ndbrain-vaults.lock}

case "${1:-}" in
  vaults)
    # Das .git jedes Vaults geht mit: darin steckt die ganze Historie, und
    # damit ist dieser eine Strom ein vollständiges Backup, kein Tagesstand.
    #
    # Streamed from a local snapshot, not from the live directory. tar used to
    # read the vaults directly while vault-history.sh committed every two
    # minutes; a commit landing mid-read made tar end with "file changed as we
    # read it" (exit 1) and the whole run was discarded. The stream crosses
    # pct exec, ssh and an NFS write on the other side, so it can take minutes
    # and the collision was routine (2026-11-17/18: about one run in five,
    # three hours in a row on the morning of the 18th).
    #
    # The copy is taken under the same lock the history commit holds, so the
    # .git inside it is never half-written, and the lock is held only for the
    # local copy (well under a second for ~30 MB), not for the slow stream.
    # Note writes by the application are not locked out; a note changing
    # during cp is caught by the next run, and cp does not fail on it.
    snap=$(mktemp -d /var/tmp/ndbrain-vaults.XXXXXX)
    trap 'rm -rf "$snap"' EXIT
    flock -w 300 "$LOCK" cp -a "$VAULTS" "$snap/"
    tar -C "$snap" -czf - "$(basename "$VAULTS")"
    ;;

  db-snapshot)
    newest=$(ls -1t "$BACKUP"/ndbrain-*.db 2>/dev/null | head -1)
    if [ -z "$newest" ]; then
      echo "kein Stand vorhanden" >&2
      exit 1
    fi
    exec gzip -c "$newest"
    ;;

  login-refusals)
    # Wie oft die Login-Bremse in der letzten Stunde jemanden abgewiesen hat.
    #
    # Die Bremse kann den Besitzer aussperren: das Konto-Budget verbraucht
    # jeder, der den Namen kennt, und die Antwort kommt vor der Passwortprüfung,
    # kann den Richtigen also nicht vom Ratenden unterscheiden. Die Antwort
    # selbst sagt bewusst nur „später". Die Zeile im Log ist damit der einzige
    # Ort, an dem das sichtbar wird — deshalb wird sie hier gezählt.
    #
    # Gezählt statt gelesen: der Zähler geht ans Backup-Ziel, und Kontonamen
    # gehören nicht dorthin. Wer wissen will, wer betroffen ist, liest das Log
    # auf diesem Container.
    cd /opt/ndbrain 2>/dev/null || { echo 0; exit 0; }
    # `grep -c` schreibt bei null Treffern eine 0 und endet trotzdem mit 1.
    # Ein `|| echo 0` dahinter gäbe deshalb zwei Zeilen, und der Checkmk-Check
    # auf der anderen Seite erwartet genau eine.
    treffer=$(docker compose logs --since 1h 2>/dev/null | grep -c 'login refused' || true)
    printf '%s\n' "${treffer:-0}"
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
