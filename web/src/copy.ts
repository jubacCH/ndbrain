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
  nav: {
    newNote: 'New note',
    folder: 'Folder',
    overview: 'Overview',
    network: 'Whole network',
    tidy: 'Tidy up',
    search: 'Search',
    files: 'Files',
    settings: 'Settings',
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
  },

  save: {
    saved: 'Saved',
    dirty: 'Unsaved',
    saving: 'Saving…',
    failed: 'Save failed',
  },

  note: {
    none: 'No note open',
    pickOne: 'Pick a note on the left, or press ⌘K and type a title.',
    readOnly: 'read only',
    canWrite: 'write',
    aboutOpen: 'About the open note',
    neighbourhood: 'Neighbourhood',
    wholeNetwork: 'whole network',
    showWholeNetwork: 'Show the whole network',
    noLinksYet: 'No links yet. Type [[ in the text to connect this note.',
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
    revokeShare: (what: string) => `Stop sharing ${what}?`,
  },

  errors: {
    serverQuiet: 'The server is not answering right now.',
    noteGone: 'That note is gone.',
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
    importFailed: (count: number, first: string) => `Could not import ${count}: ${first}`,
    /**
     * The one that was half-translated. Whole here, so it cannot happen again.
     */
    conflict: (copyName: string) =>
      `Somebody else changed this note in the meantime. Your version is the one in ` +
      `place; theirs was kept alongside it as “${copyName}”.`,
    settingsFailed: 'Could not save that setting.',
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
    sinceYesterday: 'Since yesterday',
    nothingHappened: 'Nothing happened.',
    openTasks: 'Open tasks',
    noTasks: 'No open tasks.',
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
    folderLabel: 'Folder to share',
    mayWrite: 'may also write',
    wholeVaultWarning: 'With no folder the whole vault is shared — including anything added later.',
    readWrite: 'read + write',
    readOnly: 'read only',
    withdraw: 'Withdraw',
    partlyWritable: 'partly writable',
    nobodySeesYours: 'Nobody can see into your vault.',
    nobodySharesWithYou: 'Nobody is sharing anything with you.',
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
  },

  context: {
    linksHere: 'Links here',
    orphanedNote: 'Nobody — this note is orphaned.',
    linksOut: 'Links out',
    noLinks: 'No links yet. Type [[ in the editor.',
    pointsNowhere: 'Points nowhere',
    file: 'File',
    vaultOf: (owner: string) => `${owner}'s vault`,
  },

  palette: {
    label: 'Find a note',
    placeholder: 'Open a note…',
    titleLabel: 'Note title',
    recentAppearHere: 'Recently edited notes appear here.',
    nothingFound: 'Nothing found.',
    choose: 'choose',
    open: 'open',
    close: 'close',
  },

  login: {
    password: 'Password',
    signIn: 'Sign in',
    working: 'One moment…',
    wrong: 'That name and password do not match.',
    tooMany: 'Too many attempts. Wait a moment.',
    noSelfService:
      'Accounts are created by the administrator — there is deliberately no sign-up.',
  },

  network: {
    read: 'read',
    written: 'written',
    stats: (notes: number, links: number, loose: number) =>
      `${notes} notes · ${links} links · ${loose} without a connection`,
    doubleClick: 'Double-click opens the note',
    loading: 'Relationships are loading…',
  },

  settings: {
    title: 'Settings',
    subtitle: 'Most of these belong to this browser. One of them changes what the server reports.',

    appearance: 'Appearance',
    theme: 'Theme',
    themeHint: 'The interface follows your system unless you say otherwise.',
    textSize: 'Text size',
    textSizeHint: 'Scales the whole interface, not only the note.',

    navigation: 'Navigation',
    startView: 'Open on',
    startViewHint: 'Which view you land in when ndBrain starts.',
    hidePrefixes: 'Hide sort prefixes',
    hidePrefixesHint:
      'Shows 20_Areas as “Areas”. Display only — the folder on disk keeps its digits.',
    recentCount: 'Recent notes',
    recentCountHint: 'How many recently opened notes the sidebar keeps.',
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
} as const;

/**
 * The shape a second language has to fill.
 *
 * `const de = { … } satisfies Copy` then fails to compile if a single line is
 * missing — which is the failure mode worth designing against, since a missing
 * translation is invisible until somebody hits that exact screen.
 */
export type Copy = typeof copy;
