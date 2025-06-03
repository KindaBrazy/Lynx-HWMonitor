# Lynx Hardware Monitor

Lynx Hardware Monitor is a Node.js module for monitoring system hardware components such as CPU, GPU, Memory,
Motherboard, Storage, and Network.

## Features

* **Selective Component Monitoring**: Choose which hardware components (CPU, GPU, Memory, etc.) to monitor.
* **Detailed Hardware Information**: Provides structured data including sensor readings (name, value, type, unit,
  identifier) for various hardware items.
* **Typed API**: Includes TypeScript definitions for `HardwareReport`, `SensorInfo`, `HardwareItemInfo`, `MonitorError`,
  and `ComponentType`.
* **One-Time Data Fetch**: Retrieve a snapshot of hardware data.
* **Timed Monitoring**: Continuously monitor hardware components at specified intervals.
* **Event-Driven**: Emits `data` events with `HardwareReport` and `error` events with `MonitorError`.
* **Cross-Platform Support**: Detects OS (Windows, macOS, Linux) and architecture (x64, arm64) to download the
  appropriate CLI tool.
* **Automatic CLI Management**: Downloads and manages the required `LynxHardwareCLI` from GitHub releases.
* **.NET Runtime Check**: Verifies if the required .NET 8 runtime is installed.

## Requirements

* **Node.js**: As this is a Node.js module.
* **.NET 8 Runtime**: The companion CLI tool (`LynxHardwareCLI`) requires the .NET 8 runtime to be installed. The module
  will check for this requirement. You can download it
  from [https://dotnet.microsoft.com/download/dotnet/8.0](https://dotnet.microsoft.com/download/dotnet/8.0).

## Installation

```bash
npm i @lynxhub/hwmonitor
````

Or if you use yarn:

```bash
yarn add @lynxhub/hwmonitor
```

## Usage

First, import the `HardwareMonitor` class:

```typescript
import HardwareMonitor, {HardwareReport, MonitorError, ComponentType} from '@lynxhub/hwmonitor';
import {join} from 'node:path';
import {homedir} from 'node:os';

const homeDir = homedir();
// Define a directory where the CLI tool will be downloaded and stored
const cliStorageDir = join(homeDir, 'AppData', 'Local', 'YourApp', 'HardwareMonitorCLI'); // Example for Windows

const monitor = new HardwareMonitor();

async function main() {
    try {
        // 1. Check requirements and download the CLI tool
        // This needs a directory path where the CLI can be stored.
        await monitor.checkRequirements(cliStorageDir);
        console.log('Requirements checked and CLI is ready.');

        // 2. Get data once
        console.log('Getting data once for GPU...');
        const reportOnce = await monitor.getDataOnce(['gpu'], 5000); // Monitor only GPU, 5-second timeout
        console.log('Data (once):', JSON.stringify(reportOnce, null, 2));

        // 3. Start timed monitoring
        console.log('\nStarting timed monitoring for CPU (updates every 2 seconds)...');

        monitor.on('data', (data: HardwareReport) => {
            console.log('Timed Data Received:', new Date().toISOString());
            if (data.CPU && data.CPU.length > 0 && data.CPU[0].Sensors) {
                const cpuLoad = data.CPU[0].Sensors.find(s => s.Name === 'CPU Total' && s.Type === 'Load');
                if (cpuLoad) {
                    console.log(`Current CPU Load: ${cpuLoad.Value}%`);
                }
            }
            // console.log(JSON.stringify(data, null, 2)); // Optionally log full data
        });

        monitor.on('error', (error: MonitorError) => {
            console.error('Timed Monitoring Error:', error.message);
            if (error.stderrData) console.error('Stderr:', error.stderrData);
            if (error.rawError) console.error('Raw Error:', error.rawError);
        });

        monitor.startTimed(2000, ['cpu']); // Update every 2 seconds, only CPU

        // Stop timed monitoring after a while (e.g., 10 seconds for this example)
        setTimeout(() => {
            console.log('\nStopping timed monitoring...');
            monitor.stopTimed();
            console.log('Monitoring stopped. Example finished.');
        }, 10000);

    } catch (error) {
        const monitorError = error as MonitorError; // Cast to MonitorError if it's an error from the monitor
        console.error('An error occurred:', monitorError.message);
        if (monitorError.stderrData) console.error('Stderr Data:', monitorError.stderrData);
        if (monitorError.rawError) console.error('Raw Error:', monitorError.rawError);
        // If it's the .NET runtime missing error, it will be a plain Error.
        if (error instanceof Error && error.message.includes('.NET 8 runtime')) {
            console.error("Please ensure .NET 8 runtime is installed: [https://dotnet.microsoft.com/download/dotnet/8.0](https://dotnet.microsoft.com/download/dotnet/8.0)");
        }
    }
}

main();
```

## API

### `HardwareMonitor`

An `EventEmitter` class.

#### `new HardwareMonitor()`

Creates a new instance of the hardware monitor.

#### `async checkRequirements(targetDir: string): Promise<void>`

Checks if the .NET 8 runtime is installed and downloads the necessary CLI tool to the specified `targetDir`. This
directory is used to store different versions of the `LynxHardwareCLI`.
Throws an error if .NET 8 is not found or if the CLI download fails.

#### `async getDataOnce(components?: ComponentType[], timeoutMs?: number): Promise<HardwareReport>`

Retrieves hardware data once.

* `components` (optional): Array of `ComponentType` (e.g., `['cpu', 'gpu']`) to monitor. Defaults to all components.
* `timeoutMs` (optional): Timeout in milliseconds for the operation. Defaults to 10000ms.
  Returns a Promise resolving to a `HardwareReport`.
  Throws a `MonitorError` on failure or timeout.

#### `startTimed(intervalMs: number, components?: ComponentType[]): void`

Starts timed monitoring of hardware data.

* `intervalMs`: Interval in milliseconds for data updates.
* `components` (optional): Array of `ComponentType` to monitor. Defaults to all.
  Emits `data` events with `HardwareReport` objects and `error` events with `MonitorError` objects.

#### `stopTimed(): void`

Stops the currently active timed monitoring process.

### Events

* **`data`**: Emitted during timed monitoring with a `HardwareReport` object.
  ```typescript
  monitor.on('data', (report: HardwareReport) => { /* ... */ });
  ```
* **`error`**: Emitted when an error occurs during timed monitoring or if `startTimed` is called while already active.
  Payload is a `MonitorError` object.
  ```typescript
  monitor.on('error', (error: MonitorError) => { /* ... */ });
  ```

### Types

* **`ComponentType`**: `'cpu' | 'gpu' | 'memory' | 'motherboard' | 'storage' | 'network' | string`
* **`SensorInfo`**: `{ Name: string; Value: number | null; Type: string; Unit: string; Identifier: string; }`
* **`HardwareItemInfo`**:
  `{ Name: string; HardwareType: string; Sensors: SensorInfo[]; SubHardware: HardwareItemInfo[]; }`
* **`HardwareReport`**: Contains a `Timestamp` and arrays for `CPU`, `GPU`, `Memory`, `Motherboard`, `Storage`, and
  `Network`, each being `HardwareItemInfo[]`.
* **`MonitorError`**:
  `Error & { type: 'spawn_error' | 'process_error' | 'json_parse_error' | 'timeout_error'; rawError?: any; stderrData?: string; }`

## CLI Tool (`LynxHardwareCLI`)

This module relies on an external CLI tool, `LynxHardwareCLI`. The `HardwareMonitor` module automatically handles the
download and management of this CLI.

* **Repository**: [KindaBrazy/LynxHardwareCLI](https://github.com/KindaBrazy/LynxHardwareCLI)
* **Functionality**: The `downloadAndExtractLatestCli` function within `cli_downloader.ts` fetches the latest release
  from the GitHub API, identifies the correct asset based on OS and architecture, downloads it, extracts it to a
  versioned folder within the `targetDir` provided to `checkRequirements`, and cleans up older versions.

## Scripts (from `package.json`)

* `npm run build`: Compiles TypeScript to JavaScript. (`tsc`)
* `npm start`: Builds the project and then runs `dist/index.js` (Note: `index.js` seems to be the main class definition,
  not a runnable script in itself without the example usage). The `example.ts` file provides a runnable example.

## Development

* **Linting**: Uses ESLint with TypeScript support. Configured in `eslint.config.js`.
* **Formatting**: Uses Prettier. Configured in `.prettierrc.json`.
* **TypeScript Configuration**: `tsconfig.json` specifies ESNext as target and NodeNext for module system, with output
  to `dist` directory.

___

© 2025 KindaBrazy.