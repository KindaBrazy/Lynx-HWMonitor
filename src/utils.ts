import {exec} from 'node:child_process';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
const DOTNET_LIST_RUNTIMES_COMMAND = 'dotnet --list-runtimes';
const DOTNET_8_RUNTIME_IDENTIFIER = 'microsoft.netcore.app 8.0';

function isDotNet8RuntimeInstalled(output: string): boolean {
  return output.toLowerCase().includes(DOTNET_8_RUNTIME_IDENTIFIER);
}

// Define a simple logger type that matches console's interface for warn and error
type Logger = {
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

/**
 * Checks if .NET Runtime 8 is installed on the system.
 * This function executes a command to list installed .NET runtimes and verifies
 * if .NET Runtime 8 is included in the list.
 *
 * @param {Logger} [logger=console] - Optional logger for outputting warnings or errors.
 * @return {Promise<boolean>} A promise that resolves to `true`
 * if .NET Runtime 8 is installed otherwise resolves to `false`.
 */
export async function checkDotNetRuntime8(logger: Logger = console): Promise<boolean> {
  try {
    const {stdout, stderr} = await execAsync(DOTNET_LIST_RUNTIMES_COMMAND);

    if (stderr) {
      logger.warn(`Stderr from 'dotnet --list-runtimes': ${stderr}`);
    }

    return isDotNet8RuntimeInstalled(stdout);
  } catch (error) {
    // This error usually means the 'dotnet' command is not found.
    logger.error(`Error executing 'dotnet --list-runtimes': ${(error as Error).message}`);
    return false;
  }
}
