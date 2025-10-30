import {spawn, ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import {checkDotNetRuntime9} from './utils.js';
import DownloadCli from './cli_downloader.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

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
  Uptime?: UptimeInfo;
  ElapsedTime?: UptimeInfo;
};

export type MonitorError = Error & {
  type: 'spawn_error' | 'process_error' | 'json_parse_error' | 'timeout_error';
  rawError?: any;
  stderrData?: string;
};

export type ComponentType = 'cpu' | 'gpu' | 'memory' | 'motherboard' | 'storage' | 'network' | 'uptime' | string;

export default class HardwareMonitor extends EventEmitter {
  private executablePath: string = '';
  private activeProcess: ChildProcess | null = null;
  private buffer: string = '';
  private initialMessageSkipped: boolean = false;
  private readonly creationTimestamp: number;
  private readonly logLevel: LogLevel;

  constructor(logLevel: LogLevel = 'info') {
    super();
    this.creationTimestamp = Date.now();
    this.logLevel = logLevel;
  }

  private log(level: LogLevel, ...args: any[]): void {
    const levels: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (currentLevelIndex >= messageLevelIndex && level !== 'silent') {
      if (level === 'error') {
        console.error(...args);
      } else if (level === 'warn') {
        console.warn(...args);
      } else {
        console.log(...args);
      }
    }
  }

  /**
   * Formats seconds into a human-readable string (e.g., "1d, 2h, 3m, 4s").
   * @param totalSeconds The total number of seconds.
   * @returns Formatted string.
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

  /**
   * Builds arguments for the CLI executable.
   * @param mode - 'once' or 'timed'.
   * @param intervalMs - Interval for timed mode.
   * @param components - Specific components to monitor. 'uptime' is handled internally.
   * @returns Array of string arguments.
   */
  private buildArgs(mode: 'once' | 'timed', intervalMs?: number, components?: ComponentType[]): string[] {
    const args: string[] = ['--mode', mode];
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
   * Checks for .NET 9 runtime and downloads the CLI tool.
   * @param targetDir - Directory to download the CLI tool.
   * @throws Error if .NET 9 is not found or download fails.
   */
  public async checkRequirements(targetDir: string): Promise<void> {
    const logger = {
      warn: (...args: any[]) => this.log('warn', ...args),
      error: (...args: any[]) => this.log('error', ...args),
    };

    const isDotNetInstalled = await checkDotNetRuntime9(logger);
    if (!isDotNetInstalled) {
      throw new Error(
        '.NET 9 runtime not found. Please install it from https://dotnet.microsoft.com/download/dotnet/9.0',
      );
    }
    this.executablePath = await DownloadCli(targetDir, this.logLevel);
    this.log('info', '✅ Lynx Hardware Monitor is ready to use.');
  }

  private addUptimeDataIfNeeded(report: HardwareReport, requestedComponents?: ComponentType[]): void {
    // Add uptime if no specific components were requested (implying all) OR if 'uptime' was explicitly requested.
    if (!requestedComponents || requestedComponents.length === 0 || requestedComponents.includes('uptime')) {
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
  }

  /**
   * Retrieves hardware data once.
   * @param components - Optional array of components to monitor. Defaults to all (including uptime).
   * @param timeoutMs - Optional timeout in milliseconds. Defaults to 10000ms.
   * @returns A Promise resolving to the HardwareReport.
   */
  public getDataOnce(components?: ComponentType[], timeoutMs: number = 10000): Promise<HardwareReport> {
    return new Promise((resolve, reject) => {
      if (!this.executablePath) {
        const err: MonitorError = new Error('Executable path not set. Call checkRequirements() first.') as MonitorError;
        err.type = 'spawn_error'; // Or a new specific type like 'configuration_error'
        return reject(err);
      }

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
        errorOutput += data.toString();
      });

      proc.on('error', err => {
        if (processKilled) return;
        clearTimeout(timeoutHandle);
        const monitorError: MonitorError = new Error(
          `Failed to start hardware monitor executable: ${err.message}`,
        ) as MonitorError;
        monitorError.type = 'spawn_error';
        monitorError.rawError = err;
        reject(monitorError);
      });

      proc.on('close', code => {
        if (processKilled) return;
        clearTimeout(timeoutHandle);

        if (code !== 0) {
          const err: MonitorError = new Error(
            `Hardware monitor executable exited with code ${code}. Stderr: ${errorOutput.trim()}`,
          ) as MonitorError;
          err.type = 'process_error';
          err.stderrData = errorOutput;
          return reject(err);
        }

        try {
          const parsedReport: HardwareReport = JSON.parse(output);
          let finalReport: HardwareReport;

          const cliComponentsRequested = components?.filter(comp => comp !== 'uptime');

          if (!cliComponentsRequested || cliComponentsRequested.length === 0) {
            finalReport = {
              Timestamp: parsedReport.Timestamp || new Date().toISOString(),
              CPU: parsedReport.CPU || [],
              GPU: parsedReport.GPU || [],
              Memory: parsedReport.Memory || [],
              Motherboard: parsedReport.Motherboard || [],
              Storage: parsedReport.Storage || [],
              Network: parsedReport.Network || [],
            };
          } else {
            finalReport = parsedReport;
          }

          this.addUptimeDataIfNeeded(finalReport, components);
          resolve(finalReport);
        } catch (e: any) {
          const err: MonitorError = new Error('Failed to parse JSON output from hardware monitor.') as MonitorError;
          err.type = 'json_parse_error';
          err.rawError = e;
          err.stderrData = output;
          reject(err);
        }
      });
    });
  }

  /**
   * Starts timed monitoring of hardware data.
   * Emits 'data' event with HardwareReport objects.
   * Emits 'error' event with MonitorError objects.
   * @param intervalMs - Interval in milliseconds for data updates.
   * @param components - Optional array of components to monitor. Defaults to all (including uptime).
   */
  public startTimed(intervalMs: number, components?: ComponentType[]): void {
    if (this.activeProcess) {
      this.emit('error', new Error('Timed monitoring is already active. Call stopTimed() first.'));
      return;
    }
    if (!this.executablePath) {
      const err: MonitorError = new Error('Executable path not set. Call checkRequirements() first.') as MonitorError;
      err.type = 'spawn_error';
      this.emit('error', err);
      return;
    }

    const args = this.buildArgs('timed', intervalMs, components);
    this.buffer = '';
    this.initialMessageSkipped = false;

    this.activeProcess = spawn(this.executablePath, args);

    this.activeProcess.stdout?.on('data', (dataChunk: Buffer) => {
      this.buffer += dataChunk.toString();

      if (!this.initialMessageSkipped) {
        const newlineIndex = this.buffer.indexOf('\r\n');
        if (newlineIndex !== -1) {
          const firstLine = this.buffer.substring(0, newlineIndex);
          if (!firstLine.startsWith('{')) {
            this.buffer = this.buffer.substring(newlineIndex + 2);
          }
          this.initialMessageSkipped = true;
        } else if (this.buffer.length > 1024 && !this.buffer.includes('{')) {
          this.initialMessageSkipped = true;
        } else {
          return;
        }
      }

      if (!this.initialMessageSkipped) return;

      while (this.buffer.length > 0) {
        if (!this.buffer.startsWith('{')) {
          const nextJsonStartIndex = this.buffer.indexOf('{');
          if (nextJsonStartIndex !== -1) {
            this.buffer = this.buffer.substring(nextJsonStartIndex);
          } else {
            if (this.buffer.trim() === '') this.buffer = '';
            break;
          }
        }
        if (!this.buffer.startsWith('{')) break;

        let balance = 0;
        let jsonEndIndex = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = 0; i < this.buffer.length; i++) {
          const char = this.buffer[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          if (char === '"') inString = !inString;

          if (!inString) {
            if (char === '{') balance++;
            else if (char === '}') {
              balance--;
              if (balance === 0 && i > 0) {
                jsonEndIndex = i;
                break;
              } else if (balance < 0) {
                this.buffer = '';
                this.initialMessageSkipped = false;
                const err: MonitorError = new Error(
                  'JSON braces unbalanced (too many closing). Resetting buffer.',
                ) as MonitorError;
                err.type = 'json_parse_error';
                this.emit('error', err);
                return;
              }
            }
          }
        }

        if (jsonEndIndex !== -1 && balance === 0) {
          const reportString = this.buffer.substring(0, jsonEndIndex + 1);
          let consumedLength = jsonEndIndex + 1;

          if (
            this.buffer.length > consumedLength &&
            this.buffer[consumedLength] === '\r' &&
            this.buffer.length > consumedLength + 1 &&
            this.buffer[consumedLength + 1] === '\n'
          ) {
            consumedLength += 2;
          } else if (this.buffer.length > consumedLength && this.buffer[consumedLength] === '\n') {
            consumedLength += 1;
          }

          try {
            const parsedData: any = JSON.parse(reportString);

            if (typeof parsedData.Timestamp === 'string') {
              let finalReport: HardwareReport;
              const cliComponentsRequested = components?.filter(comp => comp !== 'uptime');

              if (!cliComponentsRequested || cliComponentsRequested.length === 0) {
                finalReport = {
                  Timestamp: parsedData.Timestamp,
                  CPU: parsedData.CPU || [],
                  GPU: parsedData.GPU || [],
                  Memory: parsedData.Memory || [],
                  Motherboard: parsedData.Motherboard || [],
                  Storage: parsedData.Storage || [],
                  Network: parsedData.Network || [],
                };
              } else {
                finalReport = parsedData as HardwareReport;
              }

              this.addUptimeDataIfNeeded(finalReport, components);
              this.emit('data', finalReport);
            } else {
              const err: MonitorError = new Error(
                `Parsed JSON is not a valid HardwareReport. Snippet: ${reportString.substring(0, 100)}`,
              ) as MonitorError;
              err.type = 'json_parse_error';
              err.stderrData = reportString;
              this.emit('error', err);
            }
            this.buffer = this.buffer.substring(consumedLength);
          } catch (e: any) {
            const err: MonitorError = new Error(
              `Failed to parse JSON (timed). Snippet: ${reportString.substring(0, 100)}`,
            ) as MonitorError;
            err.type = 'json_parse_error';
            err.rawError = e;
            err.stderrData = reportString;
            this.emit('error', err);
            this.buffer = this.buffer.substring(consumedLength);
            break;
          }
        } else {
          break;
        }
      }
    });

    this.activeProcess.stderr?.on('data', data => {
      const errorMessage = data.toString().trim();
      if (errorMessage) {
        const err: MonitorError = new Error(`Error from hardware monitor process: ${errorMessage}`) as MonitorError;
        err.type = 'process_error';
        err.stderrData = errorMessage;
        this.emit('error', err);
      }
    });

    this.activeProcess.on('error', err => {
      const monitorError: MonitorError = new Error(
        `Failed to start hardware monitor executable (timed): ${err.message}`,
      ) as MonitorError;
      monitorError.type = 'spawn_error';
      monitorError.rawError = err;
      this.emit('error', monitorError);
      this.activeProcess = null;
    });

    this.activeProcess.on('close', code => {
      if (this.activeProcess && !this.activeProcess.killed && code !== 0) {
        const message = `Hardware monitor executable (timed) exited unexpectedly with code ${code}.`;
        const err: MonitorError = new Error(message) as MonitorError;
        err.type = 'process_error';
        this.emit('error', err);
      }
      this.activeProcess = null;
      this.buffer = '';
      this.initialMessageSkipped = false;
    });
  }

  /**
   * Stops the currently active timed monitoring process.
   */
  public stopTimed(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.log('debug', 'HardwareMonitor: Timed monitoring stop signal sent.');
    } else {
      this.log('debug', 'HardwareMonitor: No active timed monitoring process to stop.');
    }
  }
}
