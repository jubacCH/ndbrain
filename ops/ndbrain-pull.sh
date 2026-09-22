#!/usr/bin/env bash
#
# Holt den ndBrain-Stand von CT 132 auf den NAS-Speicher.
#
# Ziehend, nicht schiebend: CT 132 ist das System, das aus dem Internet
# erreichbar ist, und es hat von hier aus gesehen keinen Weg hierher — weder
# einen Schlüssel noch eine Route. Ein Einbruch dort erreicht das Backup
# deshalb nicht. Deswegen läuft dieses Skript hier und nicht dort.
#
# Der Weg führt über prxmx02, weil CT 132 in VLAN 30 liegt und weder von
# diesem Node noch von prxmx02 direkt per SSH erreichbar ist. `pct exec` ist
# der Weg, den Proxmox dafür vorsieht. Auf der Gegenseite hängt kein Shell-
# Zugriff, sondern /opt/ndbrain/backup-source.sh, das genau drei Dinge kennt
# und nur liest.
#
# Zwei Dinge werden gesichert, und nur das zweite ist gross:
#
#   vaults  Notizen samt .git, also die vollständige Versionsgeschichte.
#           Klein genug (rund 1,5 MB gepackt), um sie ganz zu holen. Der
#           Spiegel wird jedes Mal komplett ersetzt, damit hier nie ein
#           halber Stand aus zwei Läufen entsteht.
#
#   db      Konten, Agent-Keys, Freigaben, Einstellungen, Bearbeitungslog.
#           Das Einzige, was ndBrain nicht aus dem Vault neu bauen kann. Der
#           Container legt nachts einen konsistenten Stand ab (sqlite .backup,
#           nicht cp — die Datenbank läuft im WAL-Modus); hier wird er geholt,
#           sobald ein neuer Name auftaucht.

set -euo pipefail

SOURCE=${NDBRAIN_SOURCE:-root@prxmx02.b8n.ch}
CTID=${NDBRAIN_CTID:-132}
DEST=${NDBRAIN_BACKUP_DIR:-/mnt/pve/nfs-backup/ndbrain}
KEEP_DB=${NDBRAIN_KEEP_DB:-14}

remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$SOURCE" \
    "pct exec $CTID -- /opt/ndbrain/backup-source.sh $1"
}

# Liegt der NAS-Speicher überhaupt? Ohne diese Prüfung schriebe ein nicht
# gemounteter Pfad klaglos auf die lokale Platte des Nodes — also genau nicht
# dorthin, wo das Backup hingehört, und niemandem fiele es auf.
if ! mountpoint -q /mnt/pve/nfs-backup; then
  echo "nfs-backup ist nicht gemountet, kein Backup geschrieben" >&2
  exit 1
fi

mkdir -p "$DEST/db"

# --- Vaults ---------------------------------------------------------------
# Erst vollständig daneben auspacken, dann umschalten. Bricht die Leitung
# mitten im Strom ab, bleibt der letzte gute Spiegel unangetastet.
work="$DEST/.vaults.neu"
rm -rf "$work"
mkdir -p "$work"

# --no-same-owner: der NAS-Speicher exportiert mit root_squash, das Setzen der
# Besitzer scheitert dort grundsätzlich. Für ein Backup ist das ohne Belang —
# beim Zurückspielen werden die Rechte ohnehin neu gesetzt —, aber ohne diese
# Option endet tar mit Fehler und der Lauf sähe wie ein Ausfall aus.
if ! remote vaults | tar -C "$work" --no-same-owner -xzf -; then
  echo "Vault-Strom fehlgeschlagen, Spiegel bleibt wie er war" >&2
  rm -rf "$work"
  exit 1
fi

if [ ! -d "$work/vaults" ] || [ -z "$(ls -A "$work/vaults" 2>/dev/null)" ]; then
  echo "Vault-Strom war leer, Spiegel bleibt wie er war" >&2
  rm -rf "$work"
  exit 1
fi

rm -rf "$DEST/.vaults.alt"
[ -d "$DEST/vaults" ] && mv "$DEST/vaults" "$DEST/.vaults.alt"
mv "$work/vaults" "$DEST/vaults"
rm -rf "$work" "$DEST/.vaults.alt"

# --- Datenbank ------------------------------------------------------------
# Nur holen, wenn drüben ein Stand liegt, den wir noch nicht haben. So kann
# dieses Skript alle 15 Minuten laufen, ohne täglich 70 MB über die Leitung
# zu ziehen.
if name=$(remote db-name 2>/dev/null) && [ -n "$name" ]; then
  if [ ! -f "$DEST/db/$name.gz" ]; then
    if remote db-snapshot > "$DEST/db/$name.gz.partial"; then
      # Prüfen, dass der Strom ganz angekommen ist: ein abgeschnittenes gzip
      # fällt hier auf, nicht erst am Tag der Wiederherstellung.
      if gzip -t "$DEST/db/$name.gz.partial" 2>/dev/null; then
        mv "$DEST/db/$name.gz.partial" "$DEST/db/$name.gz"
        echo "Datenbankstand $name geholt"
      else
        echo "Datenbankstand $name kam unvollstaendig an, verworfen" >&2
        rm -f "$DEST/db/$name.gz.partial"
      fi
    else
      rm -f "$DEST/db/$name.gz.partial"
    fi
  fi

  ls -1t "$DEST"/db/ndbrain-*.db.gz 2>/dev/null | tail -n +$((KEEP_DB + 1)) | while read -r old; do
    rm -f "$old"
  done
fi

# --- Zustand der Historie drüben ----------------------------------------
# Hier abgefragt und nicht im Überwachungs-Check selbst: der Check läuft jede
# Minute, dieses Skript alle fünfzehn, und eine SSH-Verbindung pro Minute wäre
# der Preis für eine Antwort, die sich so oft gar nicht ändert.
#
# Warum es überhaupt hierher gehört: `history.ts` übersetzt jeden git-Fehler in
# "keine Versionen". Steht das Sidecar seit Wochen, sieht das in der Anwendung
# aus wie eine Notiz ohne Geschichte, nicht wie ein Ausfall. Hinschauen ist der
# einzige Weg, es zu merken.
if zustand=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$SOURCE" \
  "pct exec $CTID -- systemctl is-active ndbrain-history.timer" 2>/dev/null); then
  printf '%s\n' "$zustand" > "$DEST/historie-timer"
else
  printf 'unerreichbar\n' > "$DEST/historie-timer"
fi

# Wie oft die Login-Bremse zuletzt abgewiesen hat. Gleicher Grund wie beim
# Zeitgeber darüber: einmal je Lauf geholt statt bei jeder Abfrage, und der
# Check liest nur noch die Datei.
if zahl=$(remote login-refusals 2>/dev/null); then
  printf '%s\n' "${zahl:-0}" > "$DEST/login-abweisungen"
else
  printf 'unbekannt\n' > "$DEST/login-abweisungen"
fi

# Ein Zeitstempel, den eine Überwachung lesen kann, ohne das Verzeichnis zu
# durchsuchen: steht er still, läuft das Backup nicht mehr. Als letztes
# geschrieben, damit er nur einen Lauf datiert, der auch durchkam.
date -Is > "$DEST/zuletzt-gezogen"

notes=$(find "$DEST/vaults" -name '*.md' -not -path '*/.git/*' 2>/dev/null | wc -l)
dbs=$(ls -1 "$DEST"/db/ndbrain-*.db.gz 2>/dev/null | wc -l)
echo "Spiegel aktuell: $notes Notizen, $dbs Datenbankstaende"
