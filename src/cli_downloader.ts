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
      // Max 5 redirects
      reject(new Error('Too many redirects'));
      return;
    }

    const request = https.get(url, response => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        if (!response.headers.location) {
          reject(new Error(`Redirect with no location header from ${url}`));
          return;
        }
        log('debug', `Redirecting to ${response.headers.location}`);
        // Consume response data to free up memory
        response.resume();
        downloadFile(response.headers.location, outputPath, log, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        // Consume response data to free up memory
        response.resume();
        reject(new Error(`Failed to download file: ${response.statusCode} ${response.statusMessage} from ${url}`));
        return;
      }

      const fileStream = originalFs.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve());
      });

      fileStream.on('error', err => {
        originalFs.unlink(outputPath, () => {}); // Attempt to delete partial file
        reject(err);
      });

      response.on('error', err => {
        // Handle errors on the response stream
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
function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Node.js-Downloader', // GitHub API requires a User-Agent
          },
        },
        response => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to fetch JSON: ${response.statusCode} ${response.statusMessage} from ${url}`));
            response.resume(); // Consume data to free resources
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
        },
      )
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
    const oldVersionDirs = entries.filter(
      dirent => dirent.isDirectory() && dirent.name.startsWith(`${cliName}-`) && dirent.name !== currentVersion,
    );

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
  log('debug', `Detected system: ${osIdentifier}-${archIdentifier}`);

  if (!['win', 'osx', 'linux'].includes(osIdentifier)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!['x64', 'arm64'].includes(archIdentifier)) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  const releaseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
  let releaseData: GitHubRelease;
  try {
    log('debug', `Fetching latest release info from: ${releaseUrl}`);
    releaseData = await fetchJson<GitHubRelease>(releaseUrl);
    log('debug', `Successfully fetched release: ${releaseData.tag_name}`);
  } catch (error) {
    const errorMessage = (error as Error).message;
    log('error', `Error fetching latest release from ${releaseUrl}:`, errorMessage);

    if (errorMessage.toLowerCase().includes('403')) {
      log('warn', 'GitHub API rate limit may be exceeded. Checking for existing local versions as a fallback.');
      try {
        const dirents = await fsPromises.readdir(baseDestinationDir, {withFileTypes: true});
        const versionDirs = dirents
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name)
          .sort((a, b) => b.localeCompare(a, undefined, {numeric: true, sensitivity: 'base'}));

        if (versionDirs.length > 0) {
          const latestLocalVersion = versionDirs[0];
          const fallbackPath = path.join(baseDestinationDir, latestLocalVersion);
          log('info', `Found existing local version. Using latest available '${latestLocalVersion}' as a fallback.`);
          return fallbackPath;
        }

        log('error', `API rate limit exceeded and no local versions of ${cliName} found in ${baseDestinationDir}.`);
        throw new Error(`API rate limit exceeded and no local versions of ${cliName} are available.`);
      } catch (fsError: any) {
        if (fsError.code === 'ENOENT') {
          log('error', `API rate limit exceeded and the destination directory ${baseDestinationDir} does not exist.`);
        } else {
          log('error', 'An unexpected error occurred while finding a local fallback:', fsError.message);
        }
        throw new Error(`API rate limit exceeded and no local versions of ${cliName} are available.`);
      }
    }

    throw new Error(`Failed to fetch latest release info for ${repoOwner}/${repoName}.`);
  }

  if (!releaseData?.assets?.length) {
    throw new Error(`No assets found in the latest release for ${repoOwner}/${repoName}.`);
  }

  const versionString = releaseData.tag_name;
  const finalExtractionPath = path.resolve(baseDestinationDir, versionString);

  try {
    await fsPromises.access(finalExtractionPath);
    log('info', `Latest version '${versionString}' already exists. Skipping download.`);
    await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
    return finalExtractionPath;
  } catch {
    log('info', `New version '${versionString}' not found locally. Proceeding with download.`);
  }

  const expectedAssetName = `${cliName}-${osIdentifier}-${archIdentifier}-${versionString}.zip`;
  const targetAsset = releaseData.assets.find(asset => asset.name.toLowerCase() === expectedAssetName.toLowerCase());

  if (!targetAsset) {
    throw new Error(`Could not find asset "${expectedAssetName}" in release ${versionString}.`);
  }

  log('debug', `Found asset: ${targetAsset.name}`);

  const tempDownloadDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${cliName}-download-`));
  const zipFilePath = path.join(tempDownloadDir, targetAsset.name);

  try {
    log('debug', `Downloading ${targetAsset.name} to ${zipFilePath}...`);
    await downloadFile(targetAsset.browser_download_url, zipFilePath, log);

    log('debug', `Extracting ${zipFilePath} to ${finalExtractionPath}...`);
    await fsPromises.mkdir(finalExtractionPath, {recursive: true});
    await decompress(zipFilePath, finalExtractionPath);
    log('debug', 'Extraction complete.');

    await cleanupOldVersions(baseDestinationDir, versionString, cliName, log);
  } catch (error) {
    log('error', 'An error occurred during download or extraction:', (error as Error).message);
    throw new Error(`Failed to download and extract ${targetAsset.name}.`);
  } finally {
    await fsPromises.rm(tempDownloadDir, {recursive: true, force: true});
  }

  log('info', `${cliName} is ready at ${finalExtractionPath}`);
  return finalExtractionPath;
}

/**
 * Downloads and extracts the latest version of the CLI tool.
 * @param {string} targetDir - The base directory where the CLI tool should be saved.
 * @param {LogLevel} [logLevel='info'] - The level of logging to use.
 * @return {Promise<string>} A promise that resolves with the path to the executable.
 */
export default async function DownloadCli(targetDir: string, logLevel: LogLevel = 'info'): Promise<string> {
  const log = createLogger(logLevel);
  const repoOwner = 'KindaBrazy';
  const repoName = 'LynxHardwareCLI';
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
