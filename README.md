# Lynx Hardware Monitor

[![NPM Version](https://img.shields.io/npm/v/@lynxhub/hwmonitor?style=flat-square)](https://www.npmjs.com/package/@lynxhub/hwmonitor)
[![License](https://img.shields.io/npm/l/@lynxhub/hwmonitor?style=flat-square)](https://github.com/KindaBrazy/Lynx-HWMonitor/blob/main/LICENSE)
[![GitHub Issues](https://img.shields.io/github/issues/KindaBrazy/Lynx-HWMonitor?style=flat-square)](https://github.com/KindaBrazy/Lynx-HWMonitor/issues)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://prettier.io)
[![Linter: ESLint](https://img.shields.io/badge/linter-eslint-4B32C3.svg?style=flat-square)](https://eslint.org)
[![Built with: TypeScript](https://img.shields.io/badge/built%20with-TypeScript-007ACC.svg?style=flat-square)](https://www.typescriptlang.org/)

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

```typescript
import HardwareMonitor, {HardwareReport, MonitorError, ComponentType} from '@lynxhub/hwmonitor';
import {join} from 'node:path';
import {homedir} from 'node:os';

const homeDir = homedir();
// Define a directory where the CLI tool will be downloaded and stored.
// Choose the appropriate path for your OS or make it configurable.
// Example for Windows:
// const cliStorageDir = join(homeDir, 'AppData', 'Local', 'YourApp', 'HardwareMonitorCLI');
// Example for macOS:
// const cliStorageDir = join(homeDir, 'Library', 'Application Support', 'YourApp', 'HardwareMonitorCLI');
// Example for Linux:
// const cliStorageDir = join(homeDir, '.local', 'share', 'YourApp', 'HardwareMonitorCLI');

// Defaulting to a generic path, ensure this directory is writable.
const cliStorageDir = join(homeDir, '.your-app-name', 'HardwareMonitorCLI');

const monitor = new HardwareMonitor();

async function main() {
  try {
    // 1. Check requirements and download the CLI tool
    // This needs a directory path where the CLI can be stored.
    console.log(`Initializing Hardware Monitor... CLI will be stored in: ${cliStorageDir}`);
    await monitor.checkRequirements(cliStorageDir);
    console.log('Requirements checked and CLI is ready.');

    // 2. Get data once
    console.log('\nGetting data once for GPU, CPU, and Uptime...');
    // Monitor only GPU and CPU, with a 5-second timeout. 'uptime' is also requested.
    const reportOnce = await monitor.getDataOnce(['gpu', 'cpu', 'uptime'], 5000);
    console.log('Data (once):');
    console.log(JSON.stringify(reportOnce, null, 2));

    // Example: Accessing specific data
    if (reportOnce.CPU && reportOnce.CPU.length > 0) {
      const cpuName = reportOnce.CPU[0].Name;
      console.log(`\nCPU Name: ${cpuName}`); //
      const cpuLoadSensor = reportOnce.CPU[0].Sensors.find(s => s.Name === 'CPU Total' && s.Type === 'Load'); //
      if (cpuLoadSensor && cpuLoadSensor.Value !== null) {
        console.log(`Current CPU Load: ${cpuLoadSensor.Value.toFixed(2)}%`); //
      }
    }
    if (reportOnce.Uptime) {
      console.log(`System Uptime: ${reportOnce.Uptime.formatted}`); //
    }
    if (reportOnce.ElapsedTime) {
      console.log(`Monitor Elapsed Time: ${reportOnce.ElapsedTime.formatted}`); //
    }

    // 3. Start timed monitoring
    console.log('\nStarting timed monitoring for CPU and Memory (updates every 3 seconds)...');

    monitor.on('data', (data: HardwareReport) => { //
      console.log('\n--- Timed Data Received ---');
      console.log(`Timestamp: ${new Date(data.Timestamp).toISOString()}`); //

      if (data.CPU && data.CPU.length > 0 && data.CPU[0].Sensors) { //
        const cpuLoad = data.CPU[0].Sensors.find(s => s.Name === 'CPU Total' && s.Type === 'Load'); //
        if (cpuLoad && cpuLoad.Value !== null) {
          console.log(`Current CPU Load: ${cpuLoad.Value.toFixed(2)}%`); //
        }
      }
      if (data.Memory && data.Memory.length > 0 && data.Memory[0].Sensors) { //
        const memoryUsedSensor = data.Memory[0].Sensors.find(s => s.Name === 'Memory Used' && s.Type === 'Data'); //
        const memoryAvailableSensor = data.Memory[0].Sensors.find(s => s.Name === 'Memory Available' && s.Type === 'Data'); //
        if (memoryUsedSensor && memoryUsedSensor.Value !== null) {
          console.log(`Memory Used: ${memoryUsedSensor.Value.toFixed(2)} ${memoryUsedSensor.Unit}`); //
        }
        if (memoryAvailableSensor && memoryAvailableSensor.Value !== null) {
          console.log(`Memory Available: ${memoryAvailableSensor.Value.toFixed(2)} ${memoryAvailableSensor.Unit}`); //
        }
      }
      if (data.Uptime) { //
        console.log(`System Uptime: ${data.Uptime.formatted}`); //
      }
      if (data.ElapsedTime) { //
        console.log(`Monitor Elapsed Time: ${data.ElapsedTime.formatted}`); //
      }
      // console.log(JSON.stringify(data, null, 2)); // Optionally log full data
      console.log('--- End Timed Data ---');
    });

    monitor.on('error', (error: MonitorError) => { //
      console.error('\n--- Timed Monitoring Error ---');
      console.error(`Error Type: ${error.type}`); //
      console.error(`Message: ${error.message}`); //
      if (error.stderrData) console.error('Stderr:', error.stderrData); //
      if (error.rawError) console.error('Raw Error:', error.rawError); //
      console.error('--- End Error ---');
    });

    // Start monitoring CPU, Memory, and Uptime. Updates every 3 seconds.
    monitor.startTimed(3000, ['cpu', 'memory', 'uptime']); //

    // Stop timed monitoring after a while (e.g., 15 seconds for this example)
    setTimeout(() => {
      console.log('\nStopping timed monitoring...');
      monitor.stopTimed(); //
      console.log('Monitoring stopped. Example finished.');

      // Example of getting data again after stopping
      // Note: checkRequirements is only needed once unless cliStorageDir changes or CLI needs update.
      console.log('\nGetting data once for Storage and Uptime after stopping timed monitor...');
      monitor.getDataOnce(['storage', 'uptime'], 5000) //
              .then(report => {
                console.log('Data (storage - after stop):');
                console.log(JSON.stringify(report, null, 2));
              })
              .catch(err => {
                const monitorError = err as MonitorError;
                console.error('Error getting storage data after stop:', monitorError.message);
              });

    }, 15000);

  } catch (error) {
    console.error('\n--- An Error Occurred in Main ---');
    // Using 'as MonitorError' for type assertion to access specific properties
    const monitorError = error as MonitorError;
    console.error(`Error Type: ${monitorError.type || 'N/A'}`);
    console.error(`Message: ${monitorError.message}`);
    if (monitorError.stderrData) {
      console.error('Stderr Data:', monitorError.stderrData);
    }
    if (monitorError.rawError) {
      console.error('Raw Error:', monitorError.rawError);
    }
    // Check for the specific .NET runtime error message
    if (monitorError.message && monitorError.message.includes('.NET 8 runtime')) { //
      console.error(
              "Please ensure .NET 8 runtime is installed. " +
              "Download from: [https://dotnet.microsoft.com/download/dotnet/8.0](https://dotnet.microsoft.com/download/dotnet/8.0)" //
      );
    }
    console.error('--- End Error in Main ---');
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