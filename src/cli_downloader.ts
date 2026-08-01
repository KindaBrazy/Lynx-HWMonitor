import os from 'node:os';
import fsPromises from 'node:fs/promises';
import originalFs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import decompress from 'decompress';

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
 * Downloads a file from a given URL using Node.js https module.
 * Handles redirects.
 * @param url The URL to download from.
 * @param outputPath The path to save the downloaded file.
 * @param log The logger function.
 * @param redirectCount The current redirect count (internal use).
 * @returns A promise that resolves when the download is complete.
 */
function downloadFile(url: string, outputPath: string, log: Logger, redirectCount = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Node.js-Downloader',
      Accept: 'application/octet-stream',
    };

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = https.get(url, {headers}, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const rawLocation = response.headers.location;
        if (!rawLocation) {
          reject(new Error(`Redirect with no location header from ${url}`));
          return;
        }
        const redirectUrl = new URL(rawLocation, url).toString();
        log('debug', `Redirecting to ${redirectUrl}`);
        response.resume();
        downloadFile(redirectUrl, outputPath, log, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download file: ${response.statusCode} ${response.statusMessage} from ${url}`));
        return;
      }

      const contentLengthHeader = response.headers['content-length'];
      const expectedBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
      let downloadedBytes = 0;

      const fileStream = originalFs.createWriteStream(outputPath);

      response.on('data', chunk => {
        downloadedBytes += chunk.length;
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (expectedBytes !== null && downloadedBytes !== expectedBytes) {
            originalFs.unlink(outputPath, () => {});
            reject(
              new Error(`Download truncated: expected ${expectedBytes} bytes, but received ${downloadedBytes} bytes.`),
            );
            return;
          }
          resolve();
        });
      });

      fileStream.on('error', err => {
        originalFs.unlink(outputPath, () => {});
        reject(err);
      });

      response.on('error', err => {
        originalFs.unlink(outputPath, () => {});
        reject(err);
      });
    });

    request.on('error', err => {
      reject(err);
    });

    request.end();
  });
}

/**
 * Fetches JSON data from a URL using Node.js https module.
 * @param url The URL to fetch JSON from.
 * @returns A promise that resolves with the parsed JSON data.
 */
function fetchJson<T>(url: string, redirectCount = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while fetching JSON'));
      return;
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js-Downloader',
    };

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    https
      .get(url, {headers}, response => {
        if ([301, 302, 307, 308].includes(response.statusCode ?? 0)) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error(`Redirect with no location header from ${url}`));
            return;
          }
          response.resume();
          fetchJson<T>(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to fetch JSON: ${response.statusCode} ${response.statusMessage} from ${url}`));
          response.resume();
          return;
        }

        let rawData = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          rawData += chunk;
        });
        response.on('end', () => {
          try {
            const parsedData = JSON.parse(rawData);
            resolve(parsedData as T);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', err => {
        reject(err);
      });
  });
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
      await fsPromises.rm(oldVersionPath, {recursive: true, force: true});
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
          const exePath = path.join(candidatePath, executableName);
          try {
            await fsPromises.access(exePath, originalFs.constants.F_OK);
            validVersionDirs.push(dirent.name);
          } catch {
            log('warn', `Removing invalid/incomplete local version directory: ${candidatePath}`);
            await fsPromises.rm(candidatePath, {recursive: true, force: true}).catch(() => {});
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
      await fsPromises.access(path.join(finalExtractionPath, executableName), originalFs.constants.F_OK);
      log('info', `Latest version '${versionString}' already exists and is valid. Skipping download.`);
      await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
      return finalExtractionPath;
    } catch {
      log('info', `New version '${versionString}' not found or incomplete locally. Proceeding with download.`);
      // Clean up incomplete directory if present
      await fsPromises.rm(finalExtractionPath, {recursive: true, force: true}).catch(() => {});
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

      // Verify executable exists in extracted contents
      const extractedExePath = path.join(tempExtractionPath, executableName);
      await fsPromises.access(extractedExePath, originalFs.constants.F_OK);
      log('debug', 'Extraction and executable verification complete.');

      // Safely move extracted directory to final target location
      await fsPromises.mkdir(baseDestinationDir, {recursive: true});
      await fsPromises.rm(finalExtractionPath, {recursive: true, force: true});
      await fsPromises.rename(tempExtractionPath, finalExtractionPath);

      await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
    } catch (extractionError) {
      // Cleanup target path if partially created
      await fsPromises.rm(finalExtractionPath, {recursive: true, force: true}).catch(() => {});
      throw extractionError;
    } finally {
      await fsPromises.rm(tempDownloadDir, {recursive: true, force: true}).catch(() => {});
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

    await fsPromises.access(executablePath, originalFs.constants.F_OK);
    log('debug', `Executable ${executablePath} verified.`);
    return executablePath;
  } catch (error) {
    log('error', 'An error occurred during CLI download and setup:', (error as Error).message);
    throw error;
  }
}
