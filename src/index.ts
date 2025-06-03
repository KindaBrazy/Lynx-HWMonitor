import {spawn, ChildProcess} from 'child_process';
import {EventEmitter} from 'events';
import * as os from 'os'; // Import the 'os' module for uptime
import {checkDotNetRuntime8} from './utils.js';
import DownloadCli from './cli_downloader.js';

export type SensorInfo = {
  Name: string;
  Value: number | null;
  Type: string;
  Unit: string;
  Identifier: string;
};

export type HardwareItemInfo = {
  Name: string;
  HardwareType: string;
  Sensors: SensorInfo[];
  SubHardware: HardwareItemInfo[];
};

export type UptimeInfo = {
  rawSeconds: number;
  formatted: string;
};

export type HardwareReport = {
  Timestamp: string; // ISO Date string
  CPU: HardwareItemInfo[];
  GPU: HardwareItemInfo[];
  Memory: HardwareItemInfo[];
  Motherboard: HardwareItemInfo[];
  Storage: HardwareItemInfo[];
  Network: HardwareItemInfo[];
  Uptime?: UptimeInfo; // Optional uptime information
  ElapsedTime?: UptimeInfo; // Optional elapsed time since class creation
};

export type MonitorError = Error & {
  type: 'spawn_error' | 'process_error' | 'json_parse_error' | 'timeout_error';
  rawError?: any; // Original error from child process or parsing
  stderrData?: string; // Content from stderr if available
};

export type ComponentType = 'cpu' | 'gpu' | 'memory' | 'motherboard' | 'storage' | 'network' | 'uptime' | string;

export default class HardwareMonitor extends EventEmitter {
  private executablePath: string = '';
  private activeProcess: ChildProcess | null = null;
  private buffer: string = '';
  private creationTimestamp: number; // To store the timestamp when the class was created

  constructor() {
    super();
    this.creationTimestamp = Date.now(); // Record creation time
  }

  /**
   * Helper function to format seconds into a human-readable string.
   * @param totalSeconds The total number of seconds.
   * @returns Formatted string (e.g., "1 day, 2 hours, 3 minutes, 4 seconds").
   */
  private formatSeconds(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / (3600 * 24));
    totalSeconds %= 3600 * 24;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(', ');
  }

  private buildArgs(mode: 'once' | 'timed', intervalMs?: number, components?: ComponentType[]): string[] {
    const args: string[] = ['--mode', mode];
    // Filter out 'uptime' component as it's handled internally, not by the external CLI
    const cliComponents = components?.filter(comp => comp !== 'uptime');

    if (mode === 'timed' && intervalMs !== undefined) {
      args.push('--interval', intervalMs.toString());
    }
    if (cliComponents && cliComponents.length > 0) {
      args.push('--components', cliComponents.join(','));
    }
    return args;
  }

  /**
   * Checks if the required .NET 8 runtime is installed and downloads the CLI tool to the specified target directory.
   *
   * @param {string} targetDir - The directory where the CLI tool should be downloaded.
   * @return {Promise<void>} A promise that resolves when the requirements are successfully checked and the CLI tool is downloaded.
   */
  public async checkRequirements(targetDir: string): Promise<void> {
    const isDotNetInstalled = await checkDotNetRuntime8();

    if (!isDotNetInstalled) {
      throw new Error(
        'Failed to find .NET 8 runtime. Please install it from https://dotnet.microsoft.com/download/dotnet/8.0',
      );
    }

    this.executablePath = await DownloadCli(targetDir);
  }

  /**
   * Retrieves hardware data once.
   * @param components Optional array of components to monitor (e.g., ['cpu', 'gpu', 'uptime']). Defaults to all.
   * @param timeoutMs Optional timeout in milliseconds for the operation. Defaults to 10000ms (10 seconds).
   * @returns A Promise resolving to the HardwareReport.
   */
  public getDataOnce(components?: ComponentType[], timeoutMs: number = 10000): Promise<HardwareReport> {
    return new Promise((resolve, reject) => {
      console.log('exePath', this.executablePath);
      const args = this.buildArgs('once', undefined, components);
      let output = '';
      let errorOutput = '';
      let processKilled = false;

      const proc = spawn(this.executablePath, args);

      const timeoutHandle = setTimeout(() => {
        processKilled = true;
        proc.kill();
        const err: MonitorError = new Error(
          `Hardware monitor 'getDataOnce' timed out after ${timeoutMs}ms.`,
        ) as MonitorError;
        err.type = 'timeout_error';
        reject(err);
      }, timeoutMs);

      proc.stdout.on('data', data => {
        output += data.toString();
      });

      proc.stderr.on('data', data => {
        console.error(`HardwareMonitor (stderr - once): ${data.toString()}`);
        errorOutput += data.toString();
      });

      proc.on('error', err => {
        if (processKilled) return; // Avoid rejecting if already timed out and killed
        clearTimeout(timeoutHandle);
        const monitorError: MonitorError = new Error(
          `Failed to start hardware monitor executable: ${err.message}`,
        ) as MonitorError;
        monitorError.type = 'spawn_error';
        monitorError.rawError = err;
        reject(monitorError);
      });

      proc.on('close', code => {
        if (processKilled) return; // Avoid processing if already timed out and killed
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          const err: MonitorError = new Error(`Hardware monitor executable exited with code ${code}.`) as MonitorError;
          err.type = 'process_error';
          err.stderrData = errorOutput;
          return reject(err);
        }
        try {
          const report: HardwareReport = JSON.parse(output);

          // Add uptime and elapsed time if requested
          if (components?.includes('uptime')) {
            const osUptimeSeconds = os.uptime();
            report.Uptime = {
              rawSeconds: osUptimeSeconds,
              formatted: this.formatSeconds(osUptimeSeconds),
            };

            const elapsedTimeSeconds = (Date.now() - this.creationTimestamp) / 1000;
            report.ElapsedTime = {
              rawSeconds: elapsedTimeSeconds,
              formatted: this.formatSeconds(elapsedTimeSeconds),
            };
          }

          resolve(report);
        } catch (e) {
          const err: MonitorError = new Error('Failed to parse JSON output from hardware monitor.') as MonitorError;
          err.type = 'json_parse_error';
          err.rawError = e;
          err.stderrData = output; // The output that failed to parse
          reject(err);
        }
      });
    });
  }

  /**
   * Starts timed monitoring of hardware data.
   * Emits 'data' event with HardwareReport objects.
   * Emits 'error' event with MonitorError objects.
   * @param intervalMs Interval in milliseconds for data updates.
   * @param components Optional array of components to monitor. Defaults to all.
   */
  public startTimed(intervalMs: number, components?: ComponentType[]): void {
    if (this.activeProcess) {
      console.warn('Timed monitoring is already active. Call stopTimed() first.');
      this.emit('error', new Error('Timed monitoring is already active.'));
      return;
    }

    const args = this.buildArgs('timed', intervalMs, components);
    this.buffer = ''; // Reset buffer

    this.activeProcess = spawn(this.executablePath, args);

    this.activeProcess.stdout?.on('data', dataChunk => {
      this.buffer += dataChunk.toString();
      const potentialJsonEnd = this.buffer.lastIndexOf('}');
      if (potentialJsonEnd !== -1) {
        const potentialJsonStart = this.buffer.lastIndexOf('{', potentialJsonEnd);
        if (potentialJsonStart !== -1) {
          const jsonString = this.buffer.substring(potentialJsonStart, potentialJsonEnd + 1);
          try {
            const report: HardwareReport = JSON.parse(jsonString);

            // Add uptime and elapsed time if requested
            if (components?.includes('uptime')) {
              const osUptimeSeconds = os.uptime();
              report.Uptime = {
                rawSeconds: osUptimeSeconds,
                formatted: this.formatSeconds(osUptimeSeconds),
              };

              const elapsedTimeSeconds = (Date.now() - this.creationTimestamp) / 1000;
              report.ElapsedTime = {
                rawSeconds: elapsedTimeSeconds,
                formatted: this.formatSeconds(elapsedTimeSeconds),
              };
            }

            this.emit('data', report);
            const nextSeparator = this.buffer.indexOf('--- Next update', potentialJsonEnd);
            if (nextSeparator !== -1) {
              const endOfSeparator = this.buffer.indexOf('\n', nextSeparator);
              this.buffer = endOfSeparator !== -1 ? this.buffer.substring(endOfSeparator + 1) : '';
            } else {
              this.buffer = this.buffer.substring(potentialJsonEnd + 1);
            }
          } catch (e) {
            // Incomplete JSON or parse error, wait for more data or log error
          }
        }
      }
    });

    this.activeProcess.stderr?.on('data', data => {
      const errorMessage = data.toString();
      console.error(`HardwareMonitor (stderr - timed): ${errorMessage}`);
      const err: MonitorError = new Error(
        `Error from hardware monitor process: ${errorMessage.trim()}`,
      ) as MonitorError;
      err.type = 'process_error';
      err.stderrData = errorMessage;
      this.emit('error', err);
    });

    this.activeProcess.on('error', err => {
      const monitorError: MonitorError = new Error(
        `Failed to start hardware monitor executable (timed): ${err.message}`,
      ) as MonitorError;
      monitorError.type = 'spawn_error';
      monitorError.rawError = err;
      this.emit('error', monitorError);
      this.activeProcess = null; // Clear active process on spawn error
    });

    this.activeProcess.on('close', code => {
      if (this.activeProcess && !this.activeProcess.killed) {
        // If not killed by stopTimed()
        const message = `Hardware monitor executable (timed) exited unexpectedly with code ${code}.`;
        console.warn(message);
        const err: MonitorError = new Error(message) as MonitorError;
        err.type = 'process_error';
        this.emit('error', err);
      }
      this.activeProcess = null;
      this.buffer = '';
    });
  }

  /**
   * Stops the currently active timed monitoring process.
   */
  public stopTimed(): void {
    if (this.activeProcess) {
      this.activeProcess.kill(); // Sends SIGTERM. Use 'SIGKILL' for forceful kill if needed.
      this.activeProcess = null;
      this.buffer = '';
      console.log('HardwareMonitor: Timed monitoring stopped.');
    } else {
      console.log('HardwareMonitor: No active timed monitoring process to stop.');
    }
  }
}
