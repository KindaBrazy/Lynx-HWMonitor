import {exec} from 'node:child_process';

function checkDotNetRuntime8() {
  return new Promise((resolve, reject) => {
    // Command to check .NET runtimes
    const command = 'dotnet --list-runtimes';

    exec(command, (error, stdout, stderr) => {
      if (error) {
        // Handle cases where the 'dotnet' command might not be found or other errors
        console.error(`Error executing command: ${error.message}`);
        resolve(false); // Assume not installed or an issue occurred
        return;
      }
      if (stderr) {
        console.warn(`Stderr: ${stderr}`);
      }

      // Check the stdout for the .NET Runtime 8.0 entry
      const output = stdout.toLowerCase();
      const isDotNet8Installed = output.includes('microsoft.netcore.app 8.0');

      resolve(isDotNet8Installed);
    });
  });
}
