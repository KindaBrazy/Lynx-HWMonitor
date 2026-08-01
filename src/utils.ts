import {exec} from 'node:child_process';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
const DOTNET_LIST_RUNTIMES_COMMAND = 'dotnet --list-runtimes';
const DOTNET_10_RUNTIME_PATTERN = /microsoft\.netcore\.app\s+10\./i;

function isDotNet10RuntimeInstalled(output: string): boolean {
  return DOTNET_10_RUNTIME_PATTERN.test(output);
}

// Define a simple logger type that matches console's interface for warn and error
type Logger = {
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

/**
 * Checks if .NET Runtime 10.0 is installed on the system.
 * This function executes a command to list installed .NET runtimes and verifies
 * if .NET Runtime 10.0 is included in the list.
 *
 * @param {Logger} [logger=console] - Optional logger for outputting warnings or errors.
 * @return {Promise<boolean>} A promise that resolves to `true`
 * if .NET Runtime 10.0 is installed otherwise resolves to `false`.
 */
export async function checkDotNetRuntime10(logger: Logger = console): Promise<boolean> {
  try {
    const {stdout, stderr} = await execAsync(DOTNET_LIST_RUNTIMES_COMMAND);

    if (stderr) {
      logger.warn(`Stderr from 'dotnet --list-runtimes': ${stderr}`);
    }

    return isDotNet10RuntimeInstalled(stdout);
  } catch (error) {
    // This error usually means the 'dotnet' command is not found.
    logger.error(`Error executing 'dotnet --list-runtimes': ${(error as Error).message}`);
    return false;
  }
}

/**
 * @deprecated Use checkDotNetRuntime10 instead.
 */
export const checkDotNetRuntime9 = checkDotNetRuntime10;
