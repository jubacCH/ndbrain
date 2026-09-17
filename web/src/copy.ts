/**
 * Every word the interface says, in one place.
 *
 * Two things went wrong while the copy lived inline in the components. A
 * two-line message was rewritten on its first line and left in German on its
 * second, so the one sentence that appears at the worst possible moment —
 * somebody else's edit displaced by yours — was half in each language. And the
 * slash-command menu stayed German through a translation pass that touched every
 * other file, because nothing could enumerate what "every string" was.
 *
 * A catalogue makes both impossible: the copy can be read end to end in one
 * sitting, and a second language is a second object rather than an archaeology
 * expedition through the JSX.
 *
 * **Deliberately an object, not `t('some.key')`.** A string-keyed lookup is
 * checked by nobody: a typo compiles and renders empty, which is worse than the
 * inline text it replaced. Reaching for `copy.nav.newNote` is a type error when
 * it is wrong, and a second language declared `satisfies Copy` cannot quietly
 * omit a line.
 *
 * Functions where a value belongs inside the sentence. Concatenating fragments
 * at the call site is how translations end up with the number in the wrong
 * place, and it hides half the sentence from anyone reading this file.
 */

export const copy = {
  /**
   * The language dates and relative times are formatted in. Part of the copy
   * because it has to change with it: English sentences around German dates
   * read as a bug.
   */
  locale: 'en',

  nav: {
    /** The sidebar landmark, for a screen reader's list of regions. */
    label: 'Navigation',
    newNote: 'New note',
    folder: 'Folder',
    newFolder: 'New folder',
    overview: 'Overview',
    network: 'Whole network',
    tidy: 'Tidy up',
    tasks: 'Tasks',
    search: 'Search',
    files: 'Files',
    settings: 'Settings',
    admin: 'Admin',
    sharing: 'Sharing',
    signOut: 'Sign out',
    closeMenu: 'Close menu',
    menu: 'Menu',
    view: 'View',
    filterPlaceholder: 'Filter by name…',
    filterLabel: 'Filter the tree by name',
    clearFilter: 'Clear filter',
    recent: 'Recent',
    orphaned: 'orphaned',
    untagged: 'untagged',
    broken: 'broken',
    /** The health dots in the footer, named in full for a folded sidebar and a screen reader. */
    orphanedCount: (n: number) => `${n} orphaned ${n === 1 ? 'note' : 'notes'}`,
    untaggedCount: (n: number) => `${n} untagged ${n === 1 ? 'note' : 'notes'}`,
    brokenCount: (n: number) => `${n} broken ${n === 1 ? 'link' : 'links'}`,
    tagline: 'My Second Brain',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    open: 'open',
    filterShortcut: 'Filter the tree',
    /** Which entry of the recents list is the note on screen. */
    openNow: 'open now',
    journal: 'Journal',
    today: 'Today',
    todayHint: "Open today's note",
  },

  /** The frame around every view: the header bar and its menus. */
  shell: {
    searchPlaceholder: 'Search notes, ideas, people…',
    searchLabel: 'Search notes',
    lightTheme: 'Switch to light theme',
    darkTheme: 'Switch to dark theme',
    account: 'Account',
    signedInAs: (name: string) => `Signed in as ${name}`,
    /** The line under each view's title — real numbers, never a slogan. */
    sub: {
      overview: (notes: number, folders: number) =>
        `${notes} ${notes === 1 ? 'note' : 'notes'} · ${folders} ${folders === 1 ? 'folder' : 'folders'}`,
      attention: (n: number) => `${n} need attention`,
      network: (notes: number, links: number) =>
        `${notes} ${notes === 1 ? 'note' : 'notes'} · ${links} ${links === 1 ? 'connection' : 'connections'}`,
      loose: (n: number) => `${n} without a connection`,
      tidy: (orphans: number, broken: number, stale: number) =>
        `${orphans} orphaned · ${broken} broken ${broken === 1 ? 'link' : 'links'} · ${stale} untouched`,
      tasks: (open: number) => `${open} open ${open === 1 ? 'task' : 'tasks'}`,
      search: (notes: number) => `Full text across ${notes} ${notes === 1 ? 'note' : 'notes'}`,
      results: (n: number, q: string) => `${n} ${n === 1 ? 'result' : 'results'} for “${q}”`,
      files: (files: number, dirs: number) =>
        `${files} ${files === 1 ? 'file' : 'files'} · ${dirs} ${dirs === 1 ? 'folder' : 'folders'}`,
      settings: 'This browser, and your account',
      admin: (accounts: number) => `${accounts} ${accounts === 1 ? 'account' : 'accounts'}`,
      shares: (out: number, inbound: number) => `${out} shared by you · ${inbound} shared with you`,
      journal: (days: number, inMonth: number) =>
        `${days} ${days === 1 ? 'daily note' : 'daily notes'} · ${inMonth} this month`,
      loading: 'Loading…',
    },
    network: {
      switcher: 'How to show the network',
      graph: 'Graph',
      list: 'List',
      map: 'Map',
      fullscreen: 'Full screen',
      exitFullscreen: 'Leave full screen',
      /** Only until the list and map views arrive; see `network/ListView.tsx`. */
      notYet: (what: string) => `The ${what} view is on its way.`,
    },
  },

  save: {
    saved: 'Saved',
    dirty: 'Unsaved',
    saving: 'Saving…',
    failed: 'Save failed',
  },

  note: {
    none: 'No note open',
    /** Around a key shown as a keycap; the key itself is `paletteKey`. */
    pickOne: { before: 'Pick a note on the left, or press ', after: ' and type a title.' },
    paletteKey: '⌘K',
    readOnly: 'read only',
    canWrite: 'write',
    aboutOpen: 'About the open note',
    neighbourhood: 'Neighbourhood',
    wholeNetwork: 'whole network',
    showWholeNetwork: 'Show the whole network',
    /** The menu beside the save state in the header of an open note. */
    actions: 'Note actions',
    delete: 'Delete…',
    /** Around the link syntax, which is shown as code. */
    noLinksYet: { before: 'No links yet. Type ', after: ' in the text to connect this note.' },
    linkSyntax: '[[',
    loading: 'Loading…',
    loadingNeighbourhood: 'Loading…',
  },

  /**
   * Prompts and confirmations.
   *
   * Every destructive one names what it will do and how many, because "Are you
   * sure?" is a question nobody can answer without that.
   */
  ask: {
    newNoteName: 'Name for the new note (use / for a folder)',
    newNoteIn: (space: string) => `Name for the new note in ${space} (use / for a folder)`,
    newFolderName: 'Name for the new folder (use / to nest)',
    renameFolder: 'Rename or move this folder (new path)',
    moveTo: (count: number) => `Move ${count} notes to (empty = top of the vault)`,
    tagWith: (count: number) => `Tag ${count} notes with`,
    /* No longer 'cannot be undone': the sidecar keeps every version, and the
       history panel puts them back. Saying otherwise was true last week. */
    deleteNotes: (count: number) =>
      `Delete ${count} notes? Earlier versions stay in the history.`,
    deleteFile: (name: string) => `Delete “${name}”? This cannot be undone.`,
    deleteNote: (name: string) => `Delete “${name}”? Earlier versions stay in the history.`,
    /** Appended to `deleteNote` when the note has text that has not been saved yet. */
    unsavedDropped: 'Changes not saved yet are discarded.',
    /** Appended to `deleteNote` when other notes the caller can see link to it. */
    linksWillBreak: (count: number) =>
      `${count} ${count === 1 ? 'note links' : 'notes link'} here — ${count === 1 ? 'that link' : 'those links'} will break.`,
    revokeShare: (what: string) => `Stop sharing ${what}?`,
  },

  errors: {
    serverQuiet: 'The server is not answering right now.',
    noteGone: 'That note is gone.',
    noWriteHere: (space: string) => `You cannot write there in ${space}. Pick a folder you may write in.`,
    saveFailed: 'Could not save. Your text stays in the editor.',
    createFailed: 'Could not create that.',
    createFolderFailed: 'Could not create that folder.',
    renameFailed: 'Could not rename that.',
    searchFailed: 'Search failed.',
    bulkFailed: 'That bulk action failed.',
    shareFailed: 'Could not share that.',
    revokeFailed: 'Could not withdraw that.',
    replaceFailed: 'Could not replace that file.',
    deleteFileFailed: 'Could not delete that file.',
    deleteNoteFailed: 'Could not delete that note.',
    importFailed: (count: number, first: string) => `Could not import ${count}: ${first}`,
    /**
     * The one that was half-translated. Whole here, so it cannot happen again.
     */
    conflict: (copyName: string) =>
      `Somebody else changed this note in the meantime. Your version is the one in ` +
      `place; theirs was kept alongside it as “${copyName}”.`,
    settingsFailed: 'Could not save that setting.',
    /* The one refusal the task list is built around: the line changed under it
       rather than risk ticking the wrong one. See App.toggleTask. */
    taskChanged: 'That task changed since the list was loaded. The list has been refreshed — try again.',
    attachFailed: 'Could not attach that file.',
    closeMessage: 'Dismiss message',
  },

  overview: {
    title: 'Overview',
    notes: (count: number) => `${count} ${count === 1 ? 'note' : 'notes'}`,
    nothingToDo: 'nothing to do',
    needAttention: (count: number) => `${count} need attention`,
    needsAttention: 'Needs attention',
    clean: 'Nothing needs attention. The vault is in good order.',
    /** The findings that came back empty, said once and quietly. */
    noneOf: (labels: string[]) =>
      `No ${labels.length === 1 ? labels[0] : labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1]}.`,
    orphaned: 'orphaned',
    brokenLinks: 'broken links',
    untagged: 'untagged',
    untouched: 'untouched',
    conflictCopies: 'conflict copies',
    sinceYesterday: 'Since yesterday',
    nothingHappened: 'Nothing happened.',
    openTasks: 'Open tasks',
    noTasks: 'No open tasks.',
    seeAllTasks: 'See all tasks',
    recentlyEdited: 'Recently edited',
    nothingYet: 'Nothing yet.',
    tags: 'Tags',
    noTags: 'No tags yet.',
    loadingGraph: 'Relationships are loading…',
    deleted: 'deleted',
  },

  tidy: {
    title: 'Tidy up',
    clean: 'Nothing to do — the vault is clean.',
    found: (count: number) => `${count} findings · independent of structure, applies to any folder`,
    capped: (shown: number, total: number, shownUntagged: number, totalUntagged: number) =>
      `More findings than fit in one answer — showing the first ${shown} of ${total} orphaned, ` +
      `${shownUntagged} of ${totalUntagged} untagged. Work through these and the rest will appear.`,
    nothingSelected: 'Nothing selected',
    selected: (count: number) => `${count} selected`,
    move: 'Move…',
    tag: 'Tag…',
    delete: 'Delete…',
    path: 'Path',
    linksFollow: 'Links follow when notes move',
    selectAll: 'Select all',
    select: (title: string) => `Select ${title}`,
    note: 'Note',
    lastTouched: 'Last touched',
    findingOrphaned: 'orphaned',
    findingBroken: 'broken link',
    findingUntagged: 'untagged',
    findingUntouched: 'untouched',
    finding: 'Finding',
    conflicts: 'Conflict copies',
    conflictHint:
      'ndBrain kept these instead of losing a version overwritten by a concurrent write. ' +
      'Nothing merges automatically — open both, take what you need, then delete the copy.',
    conflictCopy: 'Copy',
    conflictOriginal: 'Original',
    conflictNoOriginal: 'Original is gone',
  },

  tasks: {
    title: 'Tasks',
    empty: 'No open tasks. Mark something with “- [ ]” in a note and it shows up here.',
    emptyFiltered: 'No open tasks match this filter.',
    found: (count: number) => `${count} open ${count === 1 ? 'task' : 'tasks'}`,
    foundIncludingDone: (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}, done included`,
    truncated: (shown: number, total: number) =>
      `Showing the first ${shown} of ${total} — narrow the folder filter to see the rest.`,
    includeDone: 'Show done',
    folder: 'Folder',
    clear: 'clear',
    check: (text: string) => `Mark “${text}” done`,
    uncheck: (text: string) => `Mark “${text}” open`,
  },

  search: {
    title: 'Search',
    nothingFound: 'Nothing found',
    /* Obsidian and Notion both do this: the query you typed is usually the
       title of the note you were looking for and did not have yet. */
    createInstead: (q: string) => `Create “${q}”`,
    results: (count: number) => `${count} ${count === 1 ? 'result' : 'results'}`,
    fromLastDays: (days: number) => `from the last ${days} days`,
    days: (days: number) => `${days} days`,
    folder: 'Folder',
    newFolder: 'New folder',
    tag: 'Tag',
    clear: 'clear',
    period: 'Period',
    property: 'Property',
  },

  files: {
    title: 'Files',
    subtitle: 'The vault as it is on disk — notes and everything beside them.',
    capped: 'Showing the first 5000 only.',
    vault: 'Vault',
    folderLabel: 'Folder',
    import: 'Import files…',
    downloadAll: 'Download all',
    empty: 'This folder is empty. Drop files here, or use “Import files”.',
    reading: 'Reading the vault…',
    name: 'Name',
    kind: 'Kind',
    size: 'Size',
    actions: 'Actions',
    folderKind: 'folder',
    fileCount: (count: number) => `${count} files`,
    download: 'Download',
    replace: 'Replace',
    delete: 'Delete',
    dropInto: (where: string) => `Drop to upload into ${where}`,
    theVault: 'the vault',
  },

  shares: {
    title: 'Sharing',
    explain: 'Every vault belongs to one person. A share opens one folder out of it — and only that folder.',
    newShare: 'Share something',
    account: 'Account',
    accountLabel: 'Account to share with',
    folder: 'Folder',
    newFolder: 'New folder',
    folderLabel: 'Folder to share',
    mayWrite: 'may also write',
    wholeVaultWarning: 'With no folder the whole vault is shared — including anything added later.',
    readWrite: 'read + write',
    readOnly: 'read only',
    withdraw: 'Withdraw',
    partlyWritable: 'partly writable',
    nobodySeesYours: 'Nobody can see into your vault.',
    nobodySharesWithYou: 'Nobody is sharing anything with you.',
    wholeVault: 'whole vault',
    vaultOf: 'Vault of',
    decline: 'Decline',
    what: 'Shared',
    kind: { vault: 'Vault', folder: 'Folder', note: 'Note' } as const,
    kindLabel: (kind: string) => `Shared ${kind.toLowerCase()}`,
  },

  /* The dialog behind "Share…" on one note — see `web/src/ShareDialog.tsx`. */
  shareNote: {
    menu: 'Share…',
    title: (title: string) => `Share “${title}”`,
    close: 'Close',
    yours: 'Your note',
    inSpace: (space: string) => `In the space ${space}`,
    person: 'Person',
    personPlaceholder: 'account name',
    right: 'Access',
    read: 'Can read',
    write: 'Can read and write',
    share: 'Share',
    follows:
      'Shares this one note. The share follows it when it is renamed or moved in ndBrain, ' +
      'and never passes to another note that later takes its name.',
    existing: 'Shared as this note',
    none: 'Nobody has this note on its own yet.',
    loading: 'Reading the members…',
    wider: 'Also reaches this note',
    withdrawLabel: (who: string) => `Withdraw ${who}’s access`,
    confirmWithdraw: (who: string, title: string) => `Withdraw ${who}’s access to “${title}”?`,
    grantFailed: 'Could not share the note.',
    withdrawFailed: 'Could not withdraw that share.',
  },

  tree: {
    /* Carbon's empty-state anatomy: name the action, say what it gets you, offer
       the one control that does it. "You have no notes" states a deficiency and
       leaves the person exactly where they were. */
    noNotes: 'Start your first note',
    noNotesWhy: 'Notes link to each other with [[double brackets]]. The links build the map.',
    noNotesAction: 'New note',
    nothingShared: 'Nothing shared.',
    noMatch: 'No match.',
    renameFolder: (name: string) => `Rename or move “${name}”`,
    renameFolderLabel: (name: string) => `Rename ${name}`,
    deleteNote: (name: string) => `Delete “${name}” (Delete key)`,
    deleteNoteLabel: (name: string) => `Delete ${name}`,
    shareNote: (name: string) => `Share “${name}”…`,
    shareNoteLabel: (name: string) => `Share ${name}`,
    spaceEmpty: 'Nothing in this space yet.',
    newNoteIn: (space: string) => `New note in ${space}`,
  },

  context: {
    linksHere: 'Links here',
    orphanedNote: 'Nobody — this note is orphaned.',
    /** A daily note nothing links to: reached by its date, so not orphaned. */
    noLinksToDay: 'No note links to this day yet.',
    /** Beside yesterday or tomorrow in a daily note, before that day is written. */
    notWrittenYet: 'not written yet — open to start it',
    linksOut: 'Links out',
    noLinks: { before: 'No links yet. Type ', after: ' in the editor.' },
    pointsNowhere: 'Points nowhere',
    file: 'File',
    vaultOf: (owner: string) => `${owner}'s vault`,
    spaceOf: (space: string) => `Space ${space}`,
  },

  palette: {
    /** Beside a command row, where a note row names its folder. */
    command: 'command',
    openToday: "Open today's note",
    /** Extra words a command is also found by. */
    openTodayKeywords: 'today daily journal heute',
    label: 'Find a note',
    placeholder: 'Open a note or search inside notes…',
    titleLabel: 'Note title or words in a note',
    /** Heading over the notes found by title and path. */
    notes: 'Notes',
    /** Heading over the full-text hits. */
    inNotes: 'In notes',
    searchAll: (q: string) => `Search all notes for “${q}”`,
    /** Beside the last row, where a note row names its folder. */
    searchView: 'search',
    recentAppearHere: 'Recently edited notes appear here.',
    nothingFound: 'Nothing found.',
    choose: 'choose',
    open: 'open',
    close: 'close',
  },

  login: {
    name: 'Name',
    password: 'Password',
    signIn: 'Sign in',
    working: 'One moment…',
    wrong: 'That name and password do not match.',
    tooMany: 'Too many attempts. Wait a moment.',
    noSelfService:
      'Accounts are created by the administrator — there is deliberately no sign-up.',
  },

  network: {
    /** Named for a screen reader; the canvas itself says nothing out loud. */
    canvas: 'Relationships between your notes',
    read: 'read',
    written: 'written',
    /**
     * The third thing in the legend, and the only one that is about the vault
     * rather than about the moment.
     *
     * `read` and `written` are what is happening right now; this is what has
     * been happening lately. The accent fades with the age, so the legend names
     * the window rather than claiming a hard line.
     */
    recent: (days: number) => `edited in the last ${days} days`,
    resetView: 'Reset view',
    doubleClick: 'Double-click opens the note',
    /** Relative times shorter than a minute. */
    justNow: 'just now',
    loading: 'Relationships are loading…',
    /**
     * The tissue is decoration and says so, in the legend, in as many words.
     *
     * Two thirds of what fills the outline is fog, folds, grain and branches
     * grown procedurally around the real notes. It is never clickable and it
     * fades out as you come closer. Naming it here is the condition under which
     * it is allowed to exist at all: nobody should have to wonder which of the
     * points on this canvas are their notes.
     */
    decoration: 'cortex tissue (decoration, not notes)',
    /** The card under the pointer. */
    card: {
      type: 'Type',
      links: (count: number) => `${count} linked ${count === 1 ? 'note' : 'notes'}`,
      linksLabel: 'Links',
      folder: 'Folder',
      region: 'Region',
      topics: 'Topics',
      noTopics: 'none',
      edited: 'Last edited',
      open: 'Double-click to open',
      today: 'today',
      yesterday: 'yesterday',
      daysAgo: (days: number) => `${days} days ago`,
      /** What a note is, from its folder (see `brain/kind.ts`). */
      kind: {
        project: 'Project',
        client: 'Client project',
        archived: 'Archived project',
        area: 'Area',
        resource: 'Resource',
        map: 'Map of content',
        rules: 'Rules',
        note: 'Note',
      },
    },

    /* The List switcher mode — see web/src/network/ListView.tsx. Appended by
       the strand that owns list and map; the rest of `network` above belongs
       to the graph canvas and is another strand's. */
    list: {
      filterPlaceholder: 'Filter by title or tag…',
      filterLabel: 'Filter the list by title or tag',
      title: 'Title',
      folder: 'Folder',
      links: 'Links',
      tags: 'Tags',
      updated: 'Updated',
      root: '(vault root)',
      /** Shown only when the graph holds more than one owner's notes. */
      owner: 'Owner',
      noTags: '—',
      moreTags: (n: number) => `+${n}`,
      empty: 'No notes match.',
      emptyVault: 'This vault has no notes yet.',
      resultCount: (shown: number, total: number) =>
        shown === total ? `${total} notes` : `${shown} of ${total} notes`,
      pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
      prevPage: 'Previous page',
      nextPage: 'Next page',
      sortAscending: (column: string) => `Sorted by ${column}, ascending`,
      sortDescending: (column: string) => `Sorted by ${column}, descending`,
      openNote: (title: string) => `Open ${title}`,
    },

    /* The Map switcher mode — see web/src/network/MapView.tsx. */
    mapView: {
      root: 'Vault',
      empty: 'This vault has no notes yet.',
      breadcrumbLabel: 'Folder path',
      folderLabel: (name: string, notes: number) =>
        `${name}, ${notes === 1 ? '1 note' : `${notes} notes`} — open`,
      noteLabel: (title: string) => `${title} — open note`,
      notes: (n: number) => (n === 1 ? '1 note' : `${n} notes`),
      links: (n: number) => (n === 1 ? '1 link' : `${n} links`),
      updated: 'Last edited',
      /** In place of a date for a folder with no edited note in it. */
      never: '—',
      hoverHint: 'Hover or focus a folder or note to see details. Click a folder to zoom in.',
    },
  },

  settings: {
    title: 'Settings',
    subtitle: 'Most of these belong to this browser. One of them changes what the server reports.',

    appearance: 'Appearance',
    theme: 'Theme',
    themeHint: 'The interface follows your system unless you say otherwise.',
    textSize: 'Text size',
    textSizeHint: 'Scales the whole interface, not only the note.',
    measure: 'Line width',
    measureHint: 'How wide a line of prose gets. Tables and code always use the room they need.',

    navigation: 'Navigation',
    startView: 'Open on',
    startViewHint: 'Which view you land in when ndBrain starts.',
    hidePrefixes: 'Hide sort prefixes',
    hidePrefixesHint:
      'Shows 20_Areas as “Areas”. Display only — the folder on disk keeps its digits.',
    showRecent: 'Recent notes',
    showRecentHint: 'A shortcut back to the notes you had open.',
    recentCount: 'How many',
    recentCountHint: 'Older ones drop off the end.',
    off: 'off',

    writing: 'Writing',
    saveDelay: 'Save after',
    saveDelayHint: 'How long typing pauses before the note is written.',

    findings: 'Findings',
    serverSide: 'Stored on the server, so every device reports the same thing.',
    staleDays: 'Call a note untouched after',
    staleDaysHint: 'Decides which notes the tidy view reports as gone quiet.',
    days: (n: number) => `${n} days`,

    account: 'Account',
    displayName: 'Display name',
    displayNameHint: 'What the interface calls you. Your sign-in name stays the same.',
    save: 'Save',
    nameSaved: 'Name changed.',
    nameFailed: 'Could not change that name.',
    roleAdmin: 'Administrator',
    roleUser: 'Account',
    passwordWhy:
      'Changing your password signs out every other device. This one stays signed in.',
    currentPassword: 'Current password',
    newPassword: 'New password',
    repeatPassword: 'Repeat new password',
    changePassword: 'Change password',
    signOutEverywhere: 'Sign out everywhere else',
    confirmSignOutAll: 'Sign out every other device? You stay signed in here.',
    passwordMismatch: 'The two new passwords do not match.',
    passwordChanged: 'Password changed. Every other device has been signed out.',
    passwordFailed: 'Could not change the password.',
    sessionsRevoked: 'Every other device has been signed out.',
    sessionsFailed: 'Could not sign the other devices out.',
  },

  history: {
    title: 'History',
    none: 'No earlier versions recorded yet.',
    noSidecar: 'No history is being recorded for this vault.',
    loading: 'Loading…',
    loadFailed: 'Could not read that version.',
    today: 'Today',
    yesterday: 'Yesterday',
    restore: 'Restore this version',
    restoreIsAnEdit:
      'Restoring writes this text back as a new edit. The current version is kept in the history, so this can be undone.',
    confirmRestore: (at: string) => `Put the version from ${at} back? The current text is kept in the history.`,
    restoreFailed: 'Could not restore that version.',
  },

  topics: {
    found: (n: number) => `${n} notes carry topics in their text.`,
    explain:
      'An import wrote them as a line in the note instead of as tags, so nothing can filter by them. This adds them as tags and leaves the text exactly as it is.',
    showPreview: 'Show what would change',
    hidePreview: 'Hide',
    apply: (n: number) => `Add tags to ${n} notes`,
    note: 'Note',
    willGet: 'Would get',
    readFrom: 'Read from',
    include: (title: string) => `Include ${title}`,
    done: (n: number) => `${n} notes tagged.`,
    failed: 'Could not add those tags.',
  },

  admin: {
    title: 'Administration',
    subtitle: 'Accounts and the keys your agents connect with. Everything here needed a shell on the server until now.',
    failed: 'That did not work.',

    accounts: 'Accounts',
    account: 'Account',
    notes: 'Notes',
    keys: 'Keys',
    since: 'Created',
    actions: 'Actions',
    admin: 'admin',
    disabled: 'disabled',
    resetPassword: 'Reset password',
    newPasswordFor: (id: string) => `New password for ${id}`,
    set: 'Set',
    cancel: 'Cancel',
    disable: 'Disable',
    enable: 'Enable',
    confirmDisable: (id: string) =>
      `Disable ${id}? They are signed out everywhere, their agent keys stop working, and they cannot sign in again until you enable them. Their notes stay where they are.`,
    disabledNow: (id: string) => `${id} is disabled.`,
    enabled: (id: string) => `${id} can sign in again.`,
    passwordReset: (id: string) => `Password changed. ${id} has been signed out everywhere.`,

    newAccount: 'New account',
    idIsPermanent:
      'The sign-in name becomes the folder their notes live in, so it cannot be changed later. The display name can.',
    signInName: 'Sign-in name',
    displayName: 'Display name',
    password: 'Password',
    makeAdmin: 'Can administer accounts and keys',
    create: 'Create account',
    created: (id: string) => `${id} created.`,

    agentKeys: 'Agent keys',
    keysExplain:
      'How an agent reaches a vault over MCP. A key is scoped to one account and, optionally, to one folder in it.',
    forAccount: 'For account',
    people: 'People',
    spacesGroup: 'Spaces',
    keysForSpace: 'A key for a space reaches into that space and nowhere else.',
    noKeys: 'No keys for this account.',
    keyName: 'Name',
    scope: 'Folder',
    wholeVault: 'the whole vault',
    lastUsed: 'Last used',
    never: 'never',
    canWrite: 'can write',
    mayWrite: 'May write, not only read',
    revoked: 'revoked',
    revoke: 'Revoke',
    confirmRevoke: (name: string) => `Revoke “${name}”? Anything using it stops working immediately.`,
    keyRevoked: (name: string) => `“${name}” revoked.`,
    newKey: 'New key',
    createKey: 'Create key',

    /* The secret exists once. Said loudly, because it is true and because an
       interface that mentions it quietly will have somebody close the tab. */
    secretOnce: 'Copy this now — it is shown once',
    secretWhy:
      'Only a hash of it is stored, so it cannot be shown again. If you lose it, revoke the key and make another.',
    gotIt: 'I have copied it',
  },

  /* Admin → Spaces — see `web/src/AdminSpaces.tsx`. */
  spaces: {
    title: 'Spaces',
    explain:
      'A space is a vault several people keep together. Nobody signs in to it: you decide who sees ' +
      'the whole space, one folder or a single note, and whether they may write. Members find it as ' +
      'its own root in their tree.',
    none: 'No spaces yet.',
    name: 'Space',
    members: 'Members',
    manage: 'Members',
    manageLabel: (name: string) => `Manage the members of ${name}`,
    rename: 'Rename',
    renameLabel: (name: string) => `Rename ${name}`,
    displayNameFor: (id: string) => `Display name for ${id}`,
    renamed: (name: string) => `Renamed to ${name}.`,
    disableLabel: (name: string) => `Disable ${name}`,
    enableLabel: (name: string) => `Enable ${name}`,
    confirmDisable: (name: string) =>
      `Disable ${name}? Its members lose access and its keys stop working until you enable it. Its notes stay where they are.`,
    disabledNow: (name: string) => `${name} is disabled.`,
    enabled: (name: string) => `${name} is enabled again.`,

    newSpace: 'New space',
    accountName: 'Account name',
    nameRule:
      'Account name: letters, digits, “-” and “_”, starting with a letter or digit, at most 64 ' +
      'characters. It must differ from every person’s and every space’s name.',
    idIsPermanent:
      'The account name becomes the folder the space’s notes live in, so it cannot be changed later. The display name can.',
    nameInvalid: 'Not a valid account name: see the rule above.',
    nameTaken: (id: string) => `“${id}” is already taken by a person or a space.`,
    create: 'Create space',
    created: (name: string) => `${name} created.`,

    membersOf: (name: string) => `Members of ${name}`,
    membersFailed: 'Could not read the members.',
    noMembers: 'Nobody is a member yet.',
    addMember: 'Add a member',
    pickPerson: 'Choose a person…',
    extentLabel: 'Extent',
    extent: { vault: 'Whole space', folder: 'Folder', note: 'Single note' } as const,
    pickFolder: 'Which folder',
    pickNote: 'Which note',
    choose: 'Choose…',
    folderExample: 'Folder/Subfolder',
    noteExample: 'Folder/Note.md',
    notVisible: 'The space’s folders and notes could not be listed. Type the path as it is in the space.',
    nothingToPick: { folder: 'This space has no folders yet.', note: 'This space has no notes yet.' } as const,
    loadingTree: 'Reading the space…',
    add: 'Add member',
    memberAdded: (who: string, space: string) => `${who} added to ${space}.`,
    removeLabel: (who: string) => `Withdraw ${who}`,
    confirmRemove: (who: string, space: string) => `Withdraw ${who}’s access to ${space}?`,
    memberRemoved: (who: string) => `${who} withdrawn.`,
  },

  crash: {
    title: 'ndBrain stopped drawing this page',
    explain:
      'Something in the interface threw an error. Your notes on the server are untouched — this ' +
      'went wrong in the browser, after they were saved.',
    pendingWarning:
      'One note had changes that had not reached the server yet. Copy them out before reloading:',
    reload: 'Reload',
    whatWentWrong: 'What went wrong',
  },

  /* The card beside a focused note in the brain — see `web/src/Inspector.tsx`.
     Everything it says is read off the vault's structure and the note's own
     text; nothing here is generated. */
  inspector: {
    label: (title: string) => `About ${title}`,
    close: 'Close',
    space: 'Space',
    vault: 'Vault of',
    type: 'Type',
    edited: 'Last edited',
    tags: 'Tags',
    noTags: 'none',
    summary: 'Summary',
    summaryLoading: 'Reading the note…',
    summaryEmpty: 'No text beyond headings and links yet.',
    connected: 'Connected',
    linksTo: 'Links to',
    linkedFrom: 'Linked from',
    noLinks: 'Not linked to any note yet.',
    showAll: (count: number) => `Show all ${count}`,
    showFewer: 'Show fewer',
    focus: (title: string) => `Focus ${title}`,
    why: 'Why?',
    whyLabel: (title: string) => `Why is ${title} connected?`,
    reason: {
      outgoing: 'direct link',
      incoming: 'direct link back',
      both: 'linked both ways',
      sameFolder: 'same folder',
      underFolder: 'both in',
      tags: (count: number) => `${count} shared ${count === 1 ? 'tag' : 'tags'}`,
      neighbours: (count: number) => `${count} shared ${count === 1 ? 'neighbour' : 'neighbours'}`,
    },
    activity: 'Activity',
    changed: 'Changed',
    open: 'Open',
    reveal: 'Show in tree',
    delete: 'Delete…',
  },
  /** The start page: where to pick up, what happened today, how the vault is doing. */
  home: {
    continue: 'Continue',
    opened: 'Opened lately',
    edited: 'Edited lately',
    noOpened: 'Notes you open show up here.',
    noEdited: 'Nothing edited yet.',
    /** The folder a note sits in, when it sits at the top of its vault. */
    topLevel: 'top level',
    editedAgo: (when: string) => `edited ${when}`,
    openNote: (title: string, folder: string) => `${title}, in ${folder} — open note`,

    today: 'Your brain today',
    newNotes: (n: number) => (n === 1 ? 'new note' : 'new notes'),
    editedNotes: (n: number) => (n === 1 ? 'note edited' : 'notes edited'),
    agentReads: (n: number) => (n === 1 ? 'agent read' : 'agent reads'),
    agentWrites: (n: number) => (n === 1 ? 'agent write' : 'agent writes'),
    quietToday: 'Nothing has changed in your vault today.',
    /** Under the counts: whose numbers they are. */
    ownVaultOnly: 'In your own vault.',
    trace: 'Last 14 days',
    traceLabel: (total: number, days: number) =>
      `Notes changed per day over the last ${days} days, ${total} in total`,
    traceDay: (date: string, n: number) => `${date}: ${n} ${n === 1 ? 'note' : 'notes'} changed`,
    sinceYesterday: 'Since yesterday',

    tasks: 'Open tasks',
    tasksMore: (n: number) => `${n} more`,

    brain: 'Your brain',
    brainHint: 'Every note and the links between them.',
    openNetwork: 'Open whole network',
  },

  /**
   * Daily notes: the calendar view, the home card and the prompts around them.
   * The note itself is written in the vault's language — see `dayHeading` in
   * `shared/journal.ts` — and none of its text is here.
   */
  journal: {
    title: 'Journal',
    calendarLabel: (month: string) => `Daily notes in ${month}`,
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    thisMonth: 'Today',
    hasNote: 'has a note',
    noNote: 'no note yet',
    today: 'today',
    dayLabel: (date: string, state: string, isToday: boolean) =>
      `${date}${isToday ? ', today' : ''}, ${state}`,
    hint: 'Arrow keys move between days, Enter opens one. Page Up and Page Down change the month.',
    askCreate: (date: string) => `There is no note for ${date} yet. Start one?`,
    count: (n: number) => `${n} ${n === 1 ? 'day' : 'days'} with a note this month`,
    failed: "Could not open that day's note.",
    shortcut: '⌘⇧D',

    card: 'Daily note',
    previousDay: 'Previous day',
    nextDay: 'Next day',
    backToToday: 'Back to today',
    open: 'Open note',
    start: "Start today's note",
    startDay: (date: string) => `Start the note for ${date}`,
    emptyNotes: 'Nothing under “Notizen” yet.',
    cardNoNote: 'No note for this day.',
    openCalendar: 'Open journal',
  },

  /** Brain health: a calm number and what it is made of. Never a reward. */
  health: {
    title: 'Brain health',
    of100: 'of 100',
    noScore: 'No notes yet, so nothing to measure.',
    scoreLabel: (score: number) => `Brain health ${score} of 100`,
    orphans: (n: number) => (n === 1 ? 'orphaned note' : 'orphaned notes'),
    broken: (n: number) => (n === 1 ? 'broken link' : 'broken links'),
    untagged: (n: number) => (n === 1 ? 'untagged note' : 'untagged notes'),
    conflicts: (n: number) => (n === 1 ? 'conflict copy' : 'conflict copies'),
    /** A category with nothing in it: said plainly, not celebrated. */
    none: 'none',
    notUsed: 'tags not in use',
    untouched: (n: number) => `${n} untouched — not part of the score`,
    attention: (n: number) => `${n} ${n === 1 ? 'note needs' : 'notes need'} attention`,
    open: 'Open Tidy up',
    showFinding: (count: number, label: string) => `Show the ${count} ${label}`,
    showAll: 'Show all findings',
    showing: (label: string) => `Showing ${label} only`,
    how: 'How the score is calculated',
    formula:
      'Each finding is taken as a share of your notes, capped at the whole, and weighted: ' +
      'orphaned 30 %, broken links 30 %, untagged 20 %, conflict copies 20 %. ' +
      'The score is 100 minus the weighted shares. Untouched notes do not count — ' +
      'a finished note is not a neglected one.',
    cost: (points: string) => `−${points}`,
  },
} as const;

/**
 * The shape a second language has to fill.
 *
 * `const de = { … } satisfies Copy` then fails to compile if a single line is
 * missing — which is the failure mode worth designing against, since a missing
 * translation is invisible until somebody hits that exact screen.
 */
export type Copy = typeof copy;
