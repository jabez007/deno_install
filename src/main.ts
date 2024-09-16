import { environment } from "./environment.ts";
import { basename, dirname, join } from "@std/path";
import $ from "@david/dax";

import {
  Bash,
  Fish,
  Posix,
  type ShellScript,
  shEnvScript,
  shSourceString,
  type SourceStringInfo,
  type UnixShell,
  Zsh,
} from "./shell.ts";
import { ensureExists, warn, withContext } from "./util.ts";
const {
  readTextFile,
  runCmd,
  writeTextFile,
} = environment;

type CompletionWriteResult = "fail" | "success" | null;

async function writeCompletionFiles(
  availableShells: UnixShell[],
): Promise<CompletionWriteResult[]> {
  const written = new Set<string>();
  const results: CompletionWriteResult[] = [];

  const decoder = new TextDecoder();

  for (const shell of availableShells) {
    if (!shell.supportsCompletion) {
      results.push(null);
      continue;
    }

    try {
      const completionFilePath = await shell.completionsFilePath?.();
      if (!completionFilePath) {
        results.push(null);
        continue;
      }
      await ensureExists(dirname(completionFilePath));
      const output = await runCmd(Deno.execPath(), ["completions", shell.name]);
      if (!output.success) {
        throw new Error(
          `deno completions subcommand failed, stderr was: ${
            decoder.decode(output.stderr)
          }`,
        );
      }
      const completionFileContents = decoder.decode(output.stdout);
      if (!completionFileContents) {
        warn(`Completions were empty, skipping ${shell.name}`);
        results.push("fail");
        continue;
      }
      let currentContents = null;
      try {
        currentContents = await readTextFile(completionFilePath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        } else {
          // nothing
        }
      }
      if (currentContents !== completionFileContents) {
        if (currentContents !== null) {
          warn(
            `an existing completion file for deno already exists at ${completionFilePath}, but is out of date. overwriting with new contents`,
          );
        }
        await writeTextFile(completionFilePath, completionFileContents);
      }
      results.push("success");
      written.add(completionFilePath);
    } catch (error) {
      warn(`Failed to install completions for ${shell.name}: ${error}`);
      results.push("fail");
      continue;
    }
  }
  return results;
}

class Backups {
  backedUp = new Set<string>();
  constructor(public backupDir: string) {}

  async add(path: string, contents: string): Promise<void> {
    if (this.backedUp.has(path)) {
      return;
    }
    const now = Date.now();
    const dest = join(this.backupDir, basename(path)) + `.bak.${now}`;
    console.log(
      `%cinfo%c: backing '${path}' up to '${dest}'`,
      "color: green",
      "color: inherit",
    );
    await Deno.writeTextFile(dest, contents);
    this.backedUp.add(path);
  }
}

async function writeCompletionRcCommands(
  availableShells: UnixShell[],
  backups: Backups,
) {
  for (const shell of availableShells) {
    if (!shell.supportsCompletion) continue;

    const rcCmd = await shell.completionsSourceString?.();
    if (!rcCmd) continue;

    for (const rc of await shell.rcsToUpdate()) {
      await updateRcFile(rc, rcCmd, backups);
    }
  }
}

async function writeEnvFiles(availableShells: UnixShell[], installDir: string) {
  const written = new Array<ShellScript>();

  let i = 0;
  while (i < availableShells.length) {
    const shell = availableShells[i];
    const script = (shell.envScript ?? shEnvScript)(installDir);

    if (!written.some((s) => s.equals(script))) {
      if (await script.write(installDir)) {
        written.push(script);
      } else {
        availableShells.splice(i);
        continue;
      }
    }

    i++;
  }
}

async function updateRcFile(
  rc: string,
  sourceString: string | SourceStringInfo,
  backups: Backups,
): Promise<boolean> {
  let prepend: string | undefined;
  let append: string | undefined;
  if (typeof sourceString === "string") {
    append = sourceString;
  } else {
    prepend = sourceString.prepend;
    append = sourceString.append;
  }
  if (!prepend && !append) {
    return false;
  }
  let prependWithNewline: string | undefined;
  let appendWithNewline: string | undefined;
  if (prepend) {
    prependWithNewline = prepend.endsWith("\n") ? prepend : prepend + "\n";
  }
  if (append) {
    appendWithNewline = append.startsWith("\n") ? append : "\n" + append;
  }

  let doPrepend: string | undefined;
  let doAppend: string | undefined;
  let contents: string | undefined;
  try {
    contents = await readTextFile(rc);
    if (prepend && !contents.includes(prepend)) {
      doPrepend = prependWithNewline;
    }
    if (append && !contents.includes(append)) {
      if (contents.endsWith("\n")) {
        doAppend = append;
      } else {
        doAppend = appendWithNewline;
      }
    }
  } catch (_error) {
    doPrepend = prependWithNewline;
    doAppend = appendWithNewline;
  }
  if (!doPrepend && !doAppend) {
    return false;
  }

  if (contents !== undefined) {
    await backups.add(rc, contents);
  }

  await ensureExists(dirname(rc));

  try {
    if (doPrepend) {
      await writeTextFile(rc, doPrepend + contents ?? "", {
        create: true,
      });
    }
    if (doAppend) {
      await writeTextFile(rc, doAppend, {
        create: true,
        append: true,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      return false;
    }
    throw withContext(`Failed to amend shell rc file: ${rc}`, error);
  }
}

async function addToPath(
  availableShells: UnixShell[],
  installDir: string,
  backups: Backups,
) {
  for (const shell of availableShells) {
    const sourceCmd = await (shell.sourceString ?? shSourceString)(installDir);

    for (const rc of await shell.rcsToUpdate()) {
      await updateRcFile(rc, sourceCmd, backups);
    }
  }
}

// Update this when adding support for a new shell
const shells: UnixShell[] = [
  new Posix(),
  new Bash(),
  new Zsh(),
  new Fish(),
];

async function getAvailableShells(): Promise<UnixShell[]> {
  const present = [];
  for (const shell of shells) {
    if (await shell.exists()) {
      present.push(shell);
    }
  }
  return present;
}

async function setupShells(installDir: string, backupDir: string) {
  const availableShells = await getAvailableShells();

  await writeEnvFiles(availableShells, installDir);

  const backups = new Backups(backupDir);

  if (await $.confirm(`Edit shell configs to add deno to the PATH?`)) {
    await ensureExists(backupDir);
    await addToPath(availableShells, installDir, backups);
  }

  const shellsWithCompletion = availableShells.filter((s) =>
    s.supportsCompletion
  );
  const selected = await $.multiSelect(
    {
      message: `Set up completions?`,
      options: shellsWithCompletion.map((s) => s.name),
    },
  );
  const completionsToSetup = selected.map((idx) => shellsWithCompletion[idx]);

  if (
    completionsToSetup.length > 0
  ) {
    await ensureExists(backupDir);
    const results = await writeCompletionFiles(completionsToSetup);
    await writeCompletionRcCommands(
      completionsToSetup.filter((_s, i) => results[i] !== "fail"),
      backups,
    );
  }
}

async function main() {
  if (Deno.build.os === "windows") {
    // the powershell script already handles setting up the path
    return;
  }

  if (Deno.args.length === 0) {
    throw new Error(
      "Expected the deno install directory as the first argument",
    );
  }

  const installDir = Deno.args[0].trim();

  const backupDir = join(installDir, ".shellRcBackups");
  await setupShells(installDir, backupDir);
}

if (import.meta.main) {
  await main();
}
