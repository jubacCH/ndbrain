import { DuplicateKeyNameError, InvalidKeyNameError, type ApiKeyService } from "./service.js";

export interface KeyCliDeps {
  keys: ApiKeyService;
}

export interface KeyCliResult {
  code: number;
  out: string;
}

const USAGE = `Usage: ndbrain key <command> [options]

Commands:
  key create <name> --scope <namespace> [--write] [--expires <iso-date>]
                                   Create a new API key
  key list                        List all API keys
  key revoke <name>                Revoke an API key by name

Options:
  --help, -h                      Show this help message
`;

/**
 * Splits argv into positionals and --flag[=nextValue] pairs.
 * Hand-rolled on purpose (YAGNI): the surface here is tiny and stable, no
 * parsing library is warranted.
 */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/** Pure argv parser/dispatcher for `ndbrain key ...`. No process access — see bin/ndbrain.ts for that. */
export async function runKeyCli(argv: string[], deps: KeyCliDeps): Promise<KeyCliResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { code: 0, out: USAGE };
  }

  const [group, sub, ...rest] = argv;
  if (group !== "key") {
    return { code: 1, out: USAGE };
  }

  switch (sub) {
    case "create":
      return createKey(rest, deps.keys);
    case "list":
      return listKeys(deps.keys);
    case "revoke":
      return revokeKey(rest, deps.keys);
    default:
      return { code: 1, out: USAGE };
  }
}

async function createKey(args: string[], keys: ApiKeyService): Promise<KeyCliResult> {
  const { positionals, flags } = parseFlags(args);
  const name = positionals[0];
  const scope = typeof flags.scope === "string" ? flags.scope : undefined;

  if (!name || scope === undefined) {
    return { code: 1, out: `Error: <name> and --scope are required.\n\n${USAGE}` };
  }

  const canWrite = flags.write === true;
  const expiresAt = typeof flags.expires === "string" ? flags.expires : undefined;

  // Validate --expires date if provided
  if (expiresAt !== undefined && Number.isNaN(new Date(expiresAt).getTime())) {
    return { code: 1, out: `Error: invalid --expires date: ${expiresAt}\n` };
  }

  try {
    const key = await keys.create(name, scope, canWrite, expiresAt);

    // ApiKeyService.create normalizes a non-empty, slash-less scope to end with "/" (a
    // bare "myai" would otherwise prefix-match siblings like "myaixyz.md" — see
    // service.ts). Mirror that same normalization here purely to report what was
    // actually stored; this is informational now, not a warning, since it's auto-fixed.
    const normalizedScope = scope !== "" && !scope.endsWith("/") ? `${scope}/` : scope;

    let out = "";
    if (normalizedScope !== scope) {
      out += `Note: scope normalized to "${normalizedScope}".\n`;
    }

    out +=
      `Created key "${name}" (scope="${normalizedScope}", write=${canWrite})\n` +
      `${key}\n\n` +
      `This key is shown only now and cannot be retrieved again — store it securely.\n`;
    return { code: 0, out };
  } catch (error) {
    if (error instanceof InvalidKeyNameError || error instanceof DuplicateKeyNameError) {
      return { code: 1, out: `Error: ${error.message}\n` };
    }
    throw error;
  }
}

function listKeys(keys: ApiKeyService): KeyCliResult {
  const entries = keys.list();
  if (entries.length === 0) {
    return { code: 0, out: "No keys found.\n" };
  }

  const header = ["NAME", "NAMESPACE", "WRITE", "CREATED", "LAST_USED", "EXPIRES"];
  const rows = entries.map((entry) => [
    entry.name,
    entry.namespace,
    entry.canWrite ? "yes" : "no",
    entry.createdAt,
    entry.lastUsedAt ?? "-",
    entry.expiresAt ?? "-",
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const formatRow = (cols: string[]) => cols.map((col, i) => col.padEnd(widths[i])).join("  ").trimEnd();

  const out = [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
  return { code: 0, out };
}

function revokeKey(args: string[], keys: ApiKeyService): KeyCliResult {
  const name = args[0];
  if (!name) {
    return { code: 1, out: `Error: <name> is required.\n\n${USAGE}` };
  }

  if (keys.revoke(name)) {
    return { code: 0, out: `Revoked key "${name}".\n` };
  }
  return { code: 1, out: `No such key: "${name}".\n` };
}
