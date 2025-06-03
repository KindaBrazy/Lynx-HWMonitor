import {exec} from 'node:child_process';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
const DOTNET_LIST_RUNTIMES_COMMAND = 'dotnet --list-runtimes';
const DOTNET_8_RUNTIME_IDENTIFIER = 'microsoft.netcore.app 8.0';

function isDotNet8RuntimeInstalled(output: string): boolean {
  return output.toLowerCase().includes(DOTNET_8_RUNTIME_IDENTIFIER);
}

/**
 * Checks if .NET Runtime 8 is installed on the system.
 * This function executes a command to list installed .NET runtimes and verifies
 * if .NET Runtime 8 is included in the list.
 *
 * @return {Promise<boolean>} A promise that resolves to `true`
 * if .NET Runtime 8 is installed otherwise resolves to `false`.
 */
export async function checkDotNetRuntime8(): Promise<boolean> {
  try {
    const {stdout, stderr} = await execAsync(DOTNET_LIST_RUNTIMES_COMMAND);

    if (stderr) {
      console.warn(`Stderr: ${stderr}`);
    }

    return isDotNet8RuntimeInstalled(stdout);
  } catch (error) {
    console.error(`Error executing command: ${(error as Error).message}`);
    return false;
  }
}
