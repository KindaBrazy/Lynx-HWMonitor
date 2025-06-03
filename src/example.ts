import {join} from 'node:path';
import HardwareMonitor, {HardwareReport, MonitorError} from './index.js';
import {homedir} from 'node:os';

const homeDir = homedir();
const targetDir = join(homeDir, 'Desktop', 'TempCli');

const monitor = new HardwareMonitor();

await monitor
  .checkRequirements(targetDir)
  .then(async () => {
    // Example 1: Get data once
    console.log('Getting data once...');
    try {
      const reportOnce = await monitor.getDataOnce(['gpu'], 5000); // 5-second timeout
      console.log('Data (once):', JSON.stringify(reportOnce, null, 2));
    } catch (error) {
      const monitorError = error as MonitorError;
      console.error('Error getting data once:', monitorError.message);
      if (monitorError.stderrData) console.error('Stderr:', monitorError.stderrData);
      if (monitorError.rawError) console.error('Raw Error:', monitorError.rawError);
    }

    console.log('\nStarting timed monitoring (for 10 seconds)...');

    // Example 2: Timed monitoring
    monitor.on('data', (data: HardwareReport) => {
      console.log('Timed Data Received:', new Date().toISOString());
      // console.log(JSON.stringify(data, null, 2)); // Optionally log full data
      if (data.CPU && data.CPU.length > 0 && data.CPU[0].Sensors) {
        const cpuLoad = data.CPU[0].Sensors.find(s => s.Name === 'CPU Total' && s.Type === 'Load');
        if (cpuLoad) {
          console.log(`Current CPU Load: ${cpuLoad.Value}%`);
        }
      }
    });

    monitor.on('error', (error: MonitorError) => {
      console.error('Timed Monitoring Error:', error.message);
      if (error.stderrData) console.error('Stderr:', error.stderrData);
    });

    monitor.startTimed(2000, ['cpu']); // Update every 2 seconds, only CPU

    // Stop timed monitoring after 10 seconds for this example
    setTimeout(() => {
      console.log('\nStopping timed monitoring...');
      monitor.stopTimed();
    }, 10000);
  })
  .catch(e => {
    console.error(e);
  });
