#!/usr/bin/env bash
#
# Checkmk-Check: steht das ndBrain-Backup noch?
#
# Gehört nach /usr/lib/check_mk_agent/local/ auf prxmx01, wo der Puller läuft.
# Checkmk findet einen Check dort von selbst und ruft ihn bei jeder Abfrage auf,
# also etwa jede Minute. Deshalb liest er nur Dateien: alles, was eine Leitung
# braucht, hat `ndbrain-pull.sh` alle fünfzehn Minuten schon getan und
# hingeschrieben.
#
# Ein Backup, das aufgehört hat, sieht aus wie ein Backup. Genau dafür ist das
# hier: die Sicherung läuft still, fällt still aus, und ohne jemanden, der
# hinschaut, merkt man es an dem Tag, an dem man sie braucht.
#
# Die Meldungstexte kommen ohne Umlaute aus. Nicht aus Nachlaessigkeit: der Text
# laeuft vom Agenten durch den Core in die Oberflaeche und moeglicherweise weiter
# in eine Benachrichtigung, und eine dieser Schichten hat ihn beim ersten Versuch
# als Latin-1 gelesen ("Der Zeitgeber laeuft" kam als "lÃ¤uft" an). Eine Meldung,
# die man im Stoerungsfall liest, ist der falsche Ort fuer diese Wette.
#
# Ausgabeformat von Checkmk: <Status> <Name> <Messwerte> <Text>
# Status 0 = OK, 1 = WARN, 2 = CRIT, 3 = UNKNOWN.

set -uo pipefail

DEST=${NDBRAIN_BACKUP_DIR:-/mnt/pve/nfs-backup/ndbrain}

# Der Puller läuft alle 15 Minuten. Eine Warnung nach 45 Minuten lässt zwei
# Läufe ausfallen, bevor sie etwas sagt — ein einzelner verpasster Lauf ist
# noch kein Ausfall, zwei sind ein Muster.
WARN_S=$((45 * 60))
CRIT_S=$((2 * 60 * 60))

# Der Datenbankstand entsteht nachts um 20:30. Ein Tag Verspätung ist ein
# ausgefallener Lauf, drei Tage sind ein Zustand, in dem man beim
# Zurückspielen Arbeit verliert.
DB_WARN_S=$((36 * 60 * 60))
DB_CRIT_S=$((72 * 60 * 60))

alter_von() {
  local datei=$1
  [ -f "$datei" ] || return 1
  echo $(( $(date +%s) - $(stat -c %Y "$datei") ))
}

menschlich() {
  local s=$1
  if [ "$s" -lt 3600 ]; then echo "$((s / 60)) min"
  elif [ "$s" -lt 86400 ]; then echo "$((s / 3600)) h"
  else echo "$((s / 86400)) Tage"
  fi
}

# --- Ist das Ziel überhaupt da? -------------------------------------------
# Zuerst, weil ein fehlender Mount jede andere Antwort wertlos macht: die
# Dateien darunter wären dann alt oder gar nicht da, und der Check würde über
# ein leeres Verzeichnis auf der lokalen Platte urteilen.
if ! mountpoint -q /mnt/pve/nfs-backup; then
  echo "2 ndBrain_Backup - Der NAS-Speicher ist nicht eingehaengt, es wird nichts gesichert"
  exit 0
fi

# --- Frische des Spiegels --------------------------------------------------
if ! alter=$(alter_von "$DEST/zuletzt-gezogen"); then
  echo "2 ndBrain_Backup - Es hat hier noch nie ein Lauf stattgefunden"
  exit 0
fi

notizen=$(find "$DEST/vaults" -name '*.md' -not -path '*/.git/*' 2>/dev/null | wc -l)
messwerte="alter=${alter}s;${WARN_S};${CRIT_S}|notizen=${notizen}"

if [ "$alter" -ge "$CRIT_S" ]; then
  echo "2 ndBrain_Backup $messwerte Letzter Lauf vor $(menschlich "$alter") - das Backup steht"
elif [ "$alter" -ge "$WARN_S" ]; then
  echo "1 ndBrain_Backup $messwerte Letzter Lauf vor $(menschlich "$alter") - zwei Laeufe ausgefallen"
elif [ "$notizen" -eq 0 ]; then
  # Frisch gelaufen und trotzdem leer: das Skript bricht bei einem leeren Strom
  # eigentlich ab, also heisst das hier, dass jemand den Spiegel geleert hat.
  echo "2 ndBrain_Backup $messwerte Der Spiegel ist leer, obwohl der Lauf durchkam"
else
  echo "0 ndBrain_Backup $messwerte $notizen Notizen, zuletzt vor $(menschlich "$alter")"
fi

# --- Frische des Datenbankstandes -----------------------------------------
# Eigener Service, weil er einen eigenen Takt hat: die Notizen kommen alle
# fünfzehn Minuten, die Datenbank einmal nachts. In einem Service vermischt
# würde der langsamere den schnelleren ständig in Warnung ziehen.
juengste=$(ls -1t "$DEST"/db/ndbrain-*.db.gz 2>/dev/null | head -1)
if [ -z "$juengste" ]; then
  echo "2 ndBrain_Backup_DB - Kein Datenbankstand vorhanden - Konten, Agent-Keys und Freigaben sind nirgends gesichert"
else
  db_alter=$(alter_von "$juengste")
  staende=$(ls -1 "$DEST"/db/ndbrain-*.db.gz 2>/dev/null | wc -l)
  db_messwerte="alter=${db_alter}s;${DB_WARN_S};${DB_CRIT_S}|staende=${staende}"

  if [ "$db_alter" -ge "$DB_CRIT_S" ]; then
    echo "2 ndBrain_Backup_DB $db_messwerte Juengster Stand ist $(menschlich "$db_alter") alt"
  elif [ "$db_alter" -ge "$DB_WARN_S" ]; then
    echo "1 ndBrain_Backup_DB $db_messwerte Juengster Stand ist $(menschlich "$db_alter") alt - ein Lauf ist ausgefallen"
  else
    echo "0 ndBrain_Backup_DB $db_messwerte $staende Staende, juengster $(menschlich "$db_alter") alt"
  fi
fi

# --- Wird jemand vom Login ausgesperrt? -----------------------------------
# Die Bremse trifft den Besitzer genauso wie den Ratenden — sie antwortet vor
# der Passwortprüfung und kann die beiden nicht unterscheiden. Wer den
# Kontonamen kennt, kann damit jemanden aussperren, solange er es durchhält.
# Das ist bewusst so, aber es muss sichtbar sein, sonst sucht der Betroffene
# den Fehler bei seinem Passwort.
if [ -f "$DEST/login-abweisungen" ]; then
  # Erste Zeile, und nur wenn sie eine Zahl ist: eine Datei, die etwas anderes
  # enthält, darf den Check nicht in eine ungültige Ausgabe kippen — Checkmk
  # liest zeilenweise, und eine zweite Zeile wäre ein zweiter, kaputter Service.
  n=$(head -1 "$DEST/login-abweisungen" 2>/dev/null | tr -cd '0-9a-z')
  case "$n" in
    unbekannt)
      echo "1 ndBrain_Login - Zustand unbekannt, der Container war beim letzten Lauf nicht erreichbar"
      ;;
    0)
      echo "0 ndBrain_Login abweisungen=0;1;20 Niemand wurde ausgebremst"
      ;;
    ''|*[!0-9]*)
      echo "3 ndBrain_Login - Der Zaehler ist unlesbar: \"$n\""
      ;;
    *)
      # Eine einzelne Abweisung ist ein vertipptes Passwort. Zwanzig in einer
      # Stunde sind niemand, der sich erinnern will.
      if [ "$n" -ge 20 ] 2>/dev/null; then
        echo "2 ndBrain_Login abweisungen=$n;1;20 $n Abweisungen in der letzten Stunde - jemand raet, und der Besitzer kommt derweil auch nicht rein"
      else
        echo "1 ndBrain_Login abweisungen=$n;1;20 $n Abweisung(en) in der letzten Stunde"
      fi
      ;;
  esac
fi

# --- Läuft die Historie drüben noch? --------------------------------------
# Vom Puller abgefragt und hier nur gelesen. Das ist der Zustand, den die
# Anwendung selbst nicht zeigen kann: `history.ts` macht aus jedem git-Fehler
# "keine Versionen", ein totes Sidecar sieht dort also aus wie eine Notiz ohne
# Geschichte.
if [ -f "$DEST/historie-timer" ]; then
  zustand=$(cat "$DEST/historie-timer")
  case "$zustand" in
    active)
      echo "0 ndBrain_Historie - Der Zeitgeber laeuft, die Versionsgeschichte wird fortgeschrieben"
      ;;
    unerreichbar)
      echo "1 ndBrain_Historie - Zustand unbekannt, der Container war beim letzten Lauf nicht erreichbar"
      ;;
    *)
      echo "2 ndBrain_Historie - Der Zeitgeber ist $zustand - es entstehen keine neuen Versionen mehr"
      ;;
  esac
fi
