# Betrieb: Historie und Backup

Diese Dateien lagen bis zum 22.09.2026 nur auf den Hosts und in keinem
Repository. Genau die Schicht, die ndBrain vor Datenverlust schützt, war damit
selbst das Unsicherste am Aufbau. Sie liegen jetzt hier; die Kopien auf den
Hosts sind identisch.

Deutsch kommentiert, im Gegensatz zum Produktcode. Der Adressat ist der
Betreiber, nicht der Compiler, und der Bestand war schon so.

## Was wo läuft

| Datei | Host | Timer | Was sie tut |
|---|---|---|---|
| `vault-history.sh` | CT 132 | alle 2 min | Committet den Vault-Stand ins `.git` **im** Vault. Die einzige Versionsgeschichte, die ndBrain kennt. |
| `db-snapshot.sh` | CT 132 | täglich 20:30 | `sqlite3 .backup` der Datenbank nach `/srv/ndbrain/backup`, 14 Stände. |
| `backup-source.sh` | CT 132 | — | Die Leseseite für das Backup. Kennt drei Befehle und schreibt nie. |
| `ndbrain-pull.sh` | prxmx01 | alle 15 min | Zieht Vaults und Datenbank nach `/mnt/pve/nfs-backup/ndbrain`. |

Die Units heissen wie die Skripte (`ndbrain-history`, `ndbrain-db-snapshot` auf
CT 132, `ndbrain-backup` auf prxmx01).

## Warum es zieht und nicht schiebt

CT 132 ist das System, das aus dem Internet erreichbar ist. Es hat von dort aus
keinen Weg zum Backup: keinen Schlüssel, keine Route. Ein Einbruch dort erreicht
die Sicherung deshalb nicht — das gilt nur, solange die Richtung bleibt.

Der Weg führt über prxmx02, weil CT 132 in VLAN 30 liegt und weder von prxmx01
noch von prxmx02 direkt per SSH erreichbar ist. `pct exec` trägt kein
bidirektionales git-Protokoll, deshalb geht ein tar-Strom über die Leitung statt
`git fetch`. Das `.git` liegt im Vault und kommt damit vollständig mit: ein Lauf
sichert alle Versionen, nicht nur den Tagesstand.

## Was gesichert ist, und was nicht

**Gesichert:** Notizen, Anhänge, die komplette Versionsgeschichte, und die
Datenbank mit Konten, Agent-Keys, Freigaben, Einstellungen und Bearbeitungslog.
Der Index in derselben Datei ist ein Cache und ginge auch ohne Backup, er liegt
nur mit drin.

**Nicht gesichert:** die letzten bis zu zwei Minuten. Was zwischen zwei Läufen
von `vault-history.sh` geschrieben und wieder überschrieben wurde, steht nirgends
— weder im git noch als Konfliktkopie. Das ist die Grenze des Aufbaus, kein
Fehler im Backup.

## Wiederherstellen

Eine einzelne Notiz, aus dem Spiegel auf dem NAS:

```bash
D=/mnt/pve/nfs-backup/ndbrain/vaults/julian
git -c safe.directory=$D -C $D log --oneline -- 'Pfad/Zur/Notiz.md'
git -c safe.directory=$D -C $D show <commit>:'Pfad/Zur/Notiz.md'
```

Alles, nach einem Totalverlust:

```bash
# 1. Vaults zurückspielen
rsync -a /mnt/pve/nfs-backup/ndbrain/vaults/ /srv/ndbrain/vaults/
chown -R 1000:1000 /srv/ndbrain/vaults

# 2. Datenbank zurückspielen (Dienst vorher stoppen)
docker compose -f /opt/ndbrain/docker-compose.yml down
gunzip -c /mnt/pve/nfs-backup/ndbrain/db/ndbrain-JJJJ-MM-TT.db.gz \
  > /srv/ndbrain/index/ndbrain.db
chown 1000:1000 /srv/ndbrain/index/ndbrain.db
docker compose -f /opt/ndbrain/docker-compose.yml up -d
```

Die Ownership nicht vergessen: der Container läuft als uid 1000, und `git` auf
dem Host verweigert ein Repository, das ihm nicht gehört, als "dubious
ownership" — die Historie wäre dann lautlos weg, ohne Fehlermeldung in der
Anwendung.

## Wonach man schauen muss

`/mnt/pve/nfs-backup/ndbrain/zuletzt-gezogen` trägt den Zeitpunkt des letzten
erfolgreichen Laufs. Steht er still, läuft das Backup nicht mehr. Das ist heute
der einzige Anhaltspunkt; eine Überwachung, die daran zieht, gibt es noch nicht.

Zweitens: ob der jüngste Commit in jedem Vault-Repository jünger als zehn
Minuten ist. `history.ts` übersetzt jeden git-Fehler in "keine Versionen", ein
ausgefallenes Sidecar sieht in der Anwendung also aus wie eine Notiz ohne
Geschichte.

## Geübt

Wiederherstellung am 22.09.2026 geprüft: eine Notiz mit zehn Versionen, älteste
Fassung aus dem Backup gelesen (9 324 Bytes gegen 22 627 heute), Datenbank mit
`PRAGMA integrity_check` auf `ok`, 2 Konten und 8 Agent-Keys gelesen. Das gehört
vierteljährlich wiederholt, mit Datum hier drunter — wer es nie gemacht hat, hat
kein Backup, sondern eine Datei.
