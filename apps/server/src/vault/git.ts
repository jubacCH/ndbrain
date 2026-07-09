import { simpleGit, CheckRepoActions, type SimpleGit } from "simple-git";

export interface HistoryEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** Git-backed change history for the vault. One commit per mutation, author = acting user/key. */
export class VaultGit {
  private git: SimpleGit;

  constructor(readonly rootDir: string) {
    this.git = simpleGit(rootDir);
  }

  async init(): Promise<void> {
    if (!(await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
      await this.git.init(["-b", "main"]);
      await this.git.addConfig("user.name", "ndbrain");
      await this.git.addConfig("user.email", "system@ndbrain.local");
      await this.git.commit("chore: initialize vault", undefined, { "--allow-empty": null });
    }
  }

  async commitChange(message: string, author: string, paths?: string[]): Promise<void> {
    if (paths && paths.length > 0) {
      await this.git.add(["-A", "--", ...paths]);
    } else {
      await this.git.add(["-A"]);
    }
    const status = await this.git.status();
    if (status.staged.length === 0 && status.renamed.length === 0) return;
    await this.git.commit(message, undefined, {
      "--author": `${author} <${author}@ndbrain.local>`,
    });
  }

  async historyFor(path: string): Promise<HistoryEntry[]> {
    try {
      const log = await this.git.log({ file: path, "--no-follow": null });
      return log.all.map((e) => ({
        hash: e.hash,
        message: e.message,
        author: e.author_name,
        date: e.date,
      }));
    } catch {
      return [];
    }
  }
}
