#!/usr/bin/env bash
#
# Historie der ndBrain-Vaults.
#
# ndBrain hält genau eine Kopie der Notizen und kennt selbst keine Versionen:
# die edits-Tabelle protokolliert, WER wann geschrieben hat, aber nicht WAS.
# Ohne diese Schicht ist jeder Fehlgriff eines Agenten und jede verrutschte
# Sammelaktion endgültig — Sammelaktionen laufen zudem bewusst ohne Transaktion.
#
# Git liegt hier absichtlich NEBEN der Anwendung, nicht in ihrem Schreibpfad:
# fällt es aus, merkt ndBrain davon nichts und speichert weiter. Es ist reine
# Historie, kein Sync — im server-zentrierten Modell gibt es nur eine Kopie,
# also auch niemanden, mit dem sie in Konflikt geraten könnte.
#
# Ein Repository pro Besitzer, weil die Mandantengrenze auch für die Historie
# gelten muss: ein Restore darf nie fremde Notizen anfassen.
#
# Die Zuordnung "wer war das" bleibt Sache der edits-Tabelle. Hier steht als
# Autor immer ndBrain selbst, weil der Zeitgeber nicht wissen kann, welcher
# Schreiber welche Datei angefasst hat.

set -uo pipefail

# systemd startet Dienste ohne HOME. git bricht dann schon bei `config --global`
# mit "$HOME not set" ab — und weil der Rest weiterläuft, sieht der Dienst nach
# Erfolg aus, während er nichts tut. Genau so verschwindet eine Sicherung
# unbemerkt, deshalb steht das hier und nicht nur in der Unit.
export HOME=${HOME:-/root}

VAULTS=${NDBRAIN_VAULTS:-/srv/ndbrain/vaults}

# Die Notizen gehören uid 1000 (der Container läuft als 1000), dieses Skript
# läuft als root — git ab 2.35 verweigert das als "dubious ownership". Die
# Ausnahme wird pro Aufruf mitgegeben statt in eine globale Konfiguration
# geschrieben: so hängt nichts an einer Datei ausserhalb dieses Skripts.
#
# Die zweite Gruppe Optionen schaltet ab, was git aus dem Repository selbst
# liest und als Kommando ausführt. Das ist hier keine Theorie: dieses Skript
# läuft als root über ein Verzeichnis, in das die Anwendung schreibt, und
# `add -A` fasst jede Datei an, die dort auftaucht. Wer je eine Datei unter
# .git/ ablegen könnte, hätte damit eine Wurzel-Shell auf diesem Container.
# Die Anwendung lehnt Pfade mit führendem Punkt inzwischen ab; diese Zeilen
# sind die zweite Hälfte derselben Absicherung, für den Fall, dass etwas
# anderes (rsync, eine Shell, ein späterer Fehler) doch dorthin schreibt.
#
#   core.fsmonitor     externes Kommando bei jedem Statuslauf
#   core.hooksPath     Hooks aus dem Repository
#   core.sshCommand    Kommando statt ssh
#   core.pager         Kommando für die Ausgabe
#   diff.external      Kommando statt des eingebauten diff
#   protocol.ext.allow ext::-Remotes, die eine Shell aufrufen
vgit() {
  local repo=$1
  shift
  git -c "safe.directory=$repo" \
      -c core.fsmonitor=false \
      -c core.hooksPath=/dev/null \
      -c core.sshCommand= \
      -c core.pager=cat \
      -c diff.external= \
      -c protocol.ext.allow=never \
      -C "$repo" "$@"
}

if [ ! -d "$VAULTS" ]; then
  echo "Vault-Verzeichnis $VAULTS existiert nicht" >&2
  exit 1
fi

shopt -s nullglob

for vault in "$VAULTS"/*/; do
  path=${vault%/}
  owner=$(basename "$path")

  # `by-name` is not a vault. It holds the readable-name signposts, which are
  # symlinks into the account directories, so everything under it is already
  # versioned in the vault it points at. Giving it a repository is not merely
  # redundant, it is what took the service down on 02.10.2026: the application
  # rewrites this directory on every start, as uid 1000, while this script runs
  # as root — so `.git/logs/HEAD`, written by a commit from here, could not be
  # unlinked and the container went into a restart loop with EACCES. The
  # application excludes the same directory from its watcher, for the same
  # reason that it is signposts and not notes.
  if [ "$owner" = 'by-name' ]; then
    continue
  fi

  if [ ! -d "$path/.git" ]; then
    vgit "$path" init --quiet --initial-branch=main || continue
    vgit "$path" config user.name 'ndBrain'
    vgit "$path" config user.email 'ndbrain@b8n.ch'
    # Nichts auszuschliessen: der Index liegt unter /srv/ndbrain/index, also
    # ausserhalb des Vaults, und Dotfiles ignoriert die App ohnehin.
    echo "Repository für $owner angelegt"
  fi

  # The same "dubious ownership" once more, from the other direction, and this
  # half was missing. Above, this script grants itself the exception because it
  # runs as root over notes owned by uid 1000. The `.git` it creates belongs to
  # root, and the application reads the same repository as uid 1000: it gets
  # exactly the same refusal, only without an exception. To it that looked like
  # a broken repository, and every newly created account got a red message in
  # its history instead of an empty list.
  #
  # Checked on every run rather than only at creation, so that vaults which
  # already have it wrong come right by themselves on the next tick.
  #
  # **Looked for across the whole tree, not just at `.git` itself.** Checking
  # the directory alone was the first version of this and it did not hold: every
  # commit from here writes new objects and a new reflog *under* a `.git` that
  # the previous run had already handed to uid 1000, and those belong to root
  # again. The directory then matches while 1305 files below it do not. That
  # went unnoticed for weeks because reading them works — git objects are
  # world-readable — and it surfaces only the moment something wants to delete
  # one.
  wantu=$(stat -c '%u' "$path")
  wantg=$(stat -c '%g' "$path")
  if [ -n "$(find "$path/.git" \( ! -uid "$wantu" -o ! -gid "$wantg" \) -print -quit 2>/dev/null)" ]; then
    if chown -R "$wantu:$wantg" "$path/.git"; then
      echo "$owner: .git gehört jetzt $wantu:$wantg, die Anwendung kann die Historie lesen"
    else
      echo "$owner: .git konnte nicht auf $wantu:$wantg gesetzt werden" >&2
    fi
  fi

  if ! vgit "$path" add -A; then
    echo "$owner: konnte Änderungen nicht vormerken" >&2
    continue
  fi

  if vgit "$path" diff --cached --quiet; then
    continue
  fi

  changed=$(vgit "$path" diff --cached --name-status)
  count=$(printf '%s\n' "$changed" | grep -c .)

  if vgit "$path" commit --quiet \
    -m "Vault-Stand $(date '+%Y-%m-%d %H:%M') · $count geändert" \
    -m "$changed"; then
    echo "$owner: $count Änderung(en) festgehalten"
  else
    echo "$owner: Commit fehlgeschlagen" >&2
  fi
done
