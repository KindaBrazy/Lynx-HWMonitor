import os from 'node:os';
import fsPromises from 'node:fs/promises';
import originalFs from 'node:fs';
import path from 'node:path';
import {exec} from 'node:child_process';
import {promisify} from 'node:util';
import decompress from 'decompress';

const execAsync = promisify(exec);

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
const logLevels: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

const createLogger =
  (logLevel: LogLevel) =>
  (level: LogLevel, ...messages: any[]) => {
    if (logLevels.indexOf(logLevel) >= logLevels.indexOf(level)) {
      if (level === 'error') console.error(...messages);
      else if (level === 'warn') console.warn(...messages);
      else if (level !== 'silent') console.log(...messages);
    }
  };
type Logger = ReturnType<typeof createLogger>;

// Interfaces for GitHub API response
type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

/**
 * Attempts to terminate any running instances of the CLI tool process to unlock files on Windows/Unix.
 * @param cliName The base name of the CLI executable.
 * @param log The logger function.
 */
async function killRunningCliProcesses(cliName: string, log: Logger): Promise<void> {
  const platform = os.platform();
  const exeName = platform === 'win32' ? `${cliName}.exe` : cliName;
  try {
    if (platform === 'win32') {
      await execAsync(`taskkill /F /IM "${exeName}"`);
    } else {
      await execAsync(`pkill -9 -f "${cliName}"`);
    }
    log('debug', `Terminated running instances of ${exeName}`);
  } catch {
    // Process was not running or couldn't be killed; ignore
  }
}

/**
 * Safely removes a directory, attempting process termination and retries if files are locked (EPERM/EBUSY).
 * @param dirPath Path to the directory to remove.
 * @param cliName Name of the CLI for process termination if locked.
 * @param log Logger function.
 * @param maxRetries Maximum number of deletion attempts.
 */
async function safeRemoveDir(dirPath: string, cliName: string, log: Logger, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fsPromises.rm(dirPath, {recursive: true, force: true});
      return;
    } catch (error: any) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        log(
          'warn',
          `Attempt ${attempt}/${maxRetries} to remove ${dirPath} failed (${error.code}).` +
            ' Stopping running CLI process...',
        );
        await killRunningCliProcesses(cliName, log);
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      } else {
        throw error;
      }
    }
  }
  // Final attempt
  await fsPromises.rm(dirPath, {recursive: true, force: true});
}

/**
 * Downloads a file from a given URL using Node.js native fetch API.
 * Automatically handles redirects and validates file size.
 * @param url The URL to download from.
 * @param outputPath The path to save the downloaded file.
 * @param log The logger function.
 */
async function downloadFile(url: string, outputPath: string, log: Logger): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': 'Node.js-Downloader',
    Accept: 'application/octet-stream',
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  log('debug', `Fetching download stream from ${url}`);
  const response = await fetch(url, {headers, redirect: 'follow'});
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText} from ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const expectedBytes = parseInt(contentLengthHeader, 10);
    if (!isNaN(expectedBytes) && buffer.length !== expectedBytes) {
      throw new Error(`Download truncated: expected ${expectedBytes} bytes, but received ${buffer.length} bytes.`);
    }
  }

  await fsPromises.writeFile(outputPath, buffer);
}

/**
 * Fetches JSON data from a URL using Node.js native fetch API.
 * @param url The URL to fetch JSON from.
 * @returns A promise that resolves with the parsed JSON data.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Node.js-Downloader',
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {headers, redirect: 'follow'});
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON: ${response.status} ${response.statusText} from ${url}`);
  }

  return (await response.json()) as T;
}

/**
 * Verifies that a directory contains all required files for running the CLI tool (.exe, .runtimeconfig.json, and .dll).
 * @param dirPath The directory path to check.
 * @param cliName The base name of the CLI tool.
 * @param executableName The name of the executable file.
 */
async function verifyCliFiles(dirPath: string, cliName: string, executableName: string): Promise<void> {
  const exePath = path.join(dirPath, executableName);
  const runtimeConfigPath = path.join(dirPath, `${cliName}.runtimeconfig.json`);
  const dllPath = path.join(dirPath, `${cliName}.dll`);

  await fsPromises.access(exePath, originalFs.constants.F_OK);
  await fsPromises.access(runtimeConfigPath, originalFs.constants.F_OK);
  await fsPromises.access(dllPath, originalFs.constants.F_OK);
}

/**
 * Cleans up old versions of the CLI tool from the base directory.
 * @param baseDir The base directory where different versions are stored.
 * @param currentVersion The version string of the currently active CLI.
 * @param cliName The base name of the CLI tool.
 * @param log The logger function.
 */
async function cleanupOldVersions(
  baseDir: string,
  currentVersion: string,
  cliName: string,
  log: Logger,
): Promise<void> {
  try {
    const entries = await fsPromises.readdir(baseDir, {withFileTypes: true});
    const oldVersionDirs = entries.filter(dirent => dirent.isDirectory() && dirent.name !== currentVersion);

    for (const dirent of oldVersionDirs) {
      const oldVersionPath = path.join(baseDir, dirent.name);
      log('debug', `Removing old version directory: ${oldVersionPath}`);
      await safeRemoveDir(oldVersionPath, cliName, log);
    }
  } catch (error) {
    log('warn', `Could not clean up old versions in ${baseDir}:`, (error as Error).message);
  }
}

/**
 * Downloads and extracts a CLI tool from the latest GitHub release.
 * @param repoOwner The owner of the GitHub repository.
 * @param repoName The name of the GitHub repository.
 * @param cliName The base name of the CLI tool.
 * @param baseDestinationDir The base directory for the CLI.
 * @param log The logger function.
 * @returns A promise that resolves to the path of the CLI tool's directory.
 */
async function downloadAndExtractLatestCli(
  repoOwner: string,
  repoName: string,
  cliName: string,
  baseDestinationDir: string,
  log: Logger,
): Promise<string> {
  log('info', `Starting setup for ${cliName} from ${repoOwner}/${repoName}...`);

  const platform = os.platform();
  const arch = os.arch();
  const osIdentifier = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  const archIdentifier = arch === 'x64' ? 'x64' : 'arm64';
  const executableName = platform === 'win32' ? `${cliName}.exe` : cliName;
  log('debug', `Detected system: ${osIdentifier}-${archIdentifier}`);

  if (!['win', 'osx', 'linux'].includes(osIdentifier)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!['x64', 'arm64'].includes(archIdentifier)) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  const fallbackToLocalVersion = async (downloadErr?: Error): Promise<string> => {
    try {
      const dirents = await fsPromises.readdir(baseDestinationDir, {withFileTypes: true});
      const validVersionDirs: string[] = [];

      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          const candidatePath = path.join(baseDestinationDir, dirent.name);
          try {
            await verifyCliFiles(candidatePath, cliName, executableName);
            validVersionDirs.push(dirent.name);
          } catch {
            log('warn', `Removing invalid/incomplete local version directory: ${candidatePath}`);
            await safeRemoveDir(candidatePath, cliName, log).catch(() => {});
          }
        }
      }

      validVersionDirs.sort((a, b) => b.localeCompare(a, undefined, {numeric: true, sensitivity: 'base'}));

      if (validVersionDirs.length > 0) {
        const latestLocalVersion = validVersionDirs[0];
        const fallbackPath = path.join(baseDestinationDir, latestLocalVersion);
        log('info', `Found existing local version. Using latest available '${latestLocalVersion}' as a fallback.`);
        return fallbackPath;
      }

      log('error', `No local versions of ${cliName} found in ${baseDestinationDir}.`);
      const reason = downloadErr ? ` (Download error: ${downloadErr.message})` : '';
      throw new Error(`No local versions of ${cliName} are available.${reason}`);
    } catch (fsError: any) {
      if (fsError.code === 'ENOENT') {
        log('error', `Destination directory ${baseDestinationDir} does not exist.`);
      } else {
        log('error', 'An unexpected error occurred while finding a local fallback:', fsError.message);
      }
      const reason = downloadErr ? ` (Download error: ${downloadErr.message})` : '';
      throw new Error(`No local versions of ${cliName} are available.${reason}`, {cause: fsError});
    }
  };

  try {
    const releaseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
    log('debug', `Fetching latest release info from: ${releaseUrl}`);
    const releaseData = await fetchJson<GitHubRelease>(releaseUrl);
    log('debug', `Successfully fetched release: ${releaseData.tag_name}`);

    if (!releaseData?.assets?.length) {
      throw new Error(`No assets found in the latest release for ${repoOwner}/${repoName}.`);
    }

    const versionString = releaseData.tag_name;
    const finalExtractionPath = path.resolve(baseDestinationDir, versionString);

    try {
      await verifyCliFiles(finalExtractionPath, cliName, executableName);
      log('info', `Latest version '${versionString}' already exists and is valid. Skipping download.`);
      await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
      return finalExtractionPath;
    } catch {
      log('info', `New version '${versionString}' not found or incomplete locally. Proceeding with download.`);
      // Clean up incomplete directory if present
      await safeRemoveDir(finalExtractionPath, cliName, log).catch(() => {});
    }

    const expectedAssetName = `${cliName}-${osIdentifier}-${archIdentifier}-${versionString}.zip`;
    const targetAsset = releaseData.assets.find(asset => asset.name.toLowerCase() === expectedAssetName.toLowerCase());

    if (!targetAsset) {
      throw new Error(`Could not find asset "${expectedAssetName}" in release ${versionString}.`);
    }

    log('debug', `Found asset: ${targetAsset.name}`);

    const tempDownloadDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${cliName}-download-`));
    const zipFilePath = path.join(tempDownloadDir, targetAsset.name);
    const tempExtractionPath = path.join(tempDownloadDir, 'extracted');

    try {
      log('debug', `Downloading ${targetAsset.name} to ${zipFilePath}...`);
      await downloadFile(targetAsset.browser_download_url, zipFilePath, log);

      log('debug', `Extracting ${zipFilePath}...`);
      await fsPromises.mkdir(tempExtractionPath, {recursive: true});
      await decompress(zipFilePath, tempExtractionPath);

      // Verify executable and required runtime configuration files exist in extracted contents
      await verifyCliFiles(tempExtractionPath, cliName, executableName);
      log('debug', 'Extraction and file verification complete.');

      // Safely move extracted directory to final target location
      await fsPromises.mkdir(baseDestinationDir, {recursive: true});
      await safeRemoveDir(finalExtractionPath, cliName, log);

      try {
        await fsPromises.rename(tempExtractionPath, finalExtractionPath);
      } catch {
        // Fallback to copy if rename fails due to permissions or cross-device mount
        await fsPromises.mkdir(finalExtractionPath, {recursive: true});
        await fsPromises.cp(tempExtractionPath, finalExtractionPath, {recursive: true, force: true});
      }

      await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
    } catch (extractionError) {
      // Cleanup target path if partially created
      await safeRemoveDir(finalExtractionPath, cliName, log).catch(() => {});
      throw extractionError;
    } finally {
      await safeRemoveDir(tempDownloadDir, cliName, log).catch(() => {});
    }

    log('info', `${cliName} is ready at ${finalExtractionPath}`);
    return finalExtractionPath;
  } catch (error) {
    const err = error as Error;
    log('warn', 'An error occurred during setup. Attempting to use a local version as fallback.', err.message);
    return await fallbackToLocalVersion(err);
  }
}

/**
 * Downloads and extracts the latest version of the CLI tool.
 * @param {string} targetDir - The base directory where the CLI tool should be saved.
 * @param {LogLevel} [logLevel='info'] - The level of logging to use.
 * @return {Promise<string>} A promise that resolves with the path to the executable.
 */
export default async function DownloadCli(targetDir: string, logLevel: LogLevel = 'info'): Promise<string> {
  const log = createLogger(logLevel);
  const repoOwner = 'TheLynxHub';
  const repoName = 'Lynx-HardwareCLI';
  const cliName = 'LynxHardwareCLI';
  const cliBaseDir = path.join(targetDir, cliName);

  try {
    const extractedPath = await downloadAndExtractLatestCli(repoOwner, repoName, cliName, cliBaseDir, log);
    log('debug', `CLI tool is ready at: ${extractedPath}`);

    const executableName = os.platform() === 'win32' ? `${cliName}.exe` : cliName;
    const executablePath = path.join(extractedPath, executableName);
    log('debug', `Executable should be at: ${executablePath}`);

    await verifyCliFiles(extractedPath, cliName, executableName);
    log('debug', `Executable and configuration files verified at: ${extractedPath}`);
    return executablePath;
  } catch (error) {
    log('error', 'An error occurred during CLI download and setup:', (error as Error).message);
    throw error;
  }
}
