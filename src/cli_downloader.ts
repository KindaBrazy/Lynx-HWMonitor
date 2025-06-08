import os from 'node:os';
import fsPromises from 'node:fs/promises';
import originalFs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import decompress from 'decompress';

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
 * @param redirectCount The current redirect count (internal use).
 * @returns A promise that resolves when the download is complete.
 */
function downloadFile(url: string, outputPath: string, redirectCount = 0): Promise<void> {
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
        console.log(`Redirecting to ${response.headers.location}`);
        // Consume response data to free up memory
        response.resume();
        downloadFile(response.headers.location, outputPath, redirectCount + 1)
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
 * It removes any subdirectories that are not the current version.
 * @param baseDir The base directory where different versions are stored.
 * @param currentVersion The version string of the currently active CLI.
 * @param cliName The base name of the CLI tool (e.g., 'LynxHardwareCLI').
 */
async function cleanupOldVersions(baseDir: string, currentVersion: string, cliName: string): Promise<void> {
  try {
    const entries = await fsPromises.readdir(baseDir, {withFileTypes: true});
    const oldVersionDirs = entries.filter(
      dirent =>
        dirent.isDirectory() &&
        dirent.name.startsWith(`${cliName}-`) && // Assuming version folders start with cliName-
        dirent.name !== currentVersion, // Don't remove the current version
    );

    for (const dirent of oldVersionDirs) {
      const oldVersionPath = path.join(baseDir, dirent.name);
      console.log(`Removing old version directory: ${oldVersionPath}`);
      await fsPromises.rm(oldVersionPath, {recursive: true, force: true});
    }
  } catch (error) {
    // Ignore errors if the directory doesn't exist or other cleanup issues
    console.warn(`Warning: Could not clean up old versions in ${baseDir}:`, (error as Error).message);
  }
}

/**
 * Downloads and extracts a CLI tool from the latest GitHub release.
 * If the GitHub API is rate-limited, it will attempt to use the latest locally available version.
 *
 * @param repoOwner The owner of the GitHub repository.
 * @param repoName The name of the GitHub repository.
 * @param cliName The base name of the CLI tool.
 * @param baseDestinationDir The base directory where the CLI tool's versions will be stored.
 * @returns A promise that resolves to the path of the CLI tool's directory.
 * @throws Will throw an error if fetching fails and no local fallback is available.
 */
async function downloadAndExtractLatestCli(
  repoOwner: string,
  repoName: string,
  cliName: string,
  baseDestinationDir: string,
): Promise<string> {
  console.log(`Starting download process for ${cliName} from ${repoOwner}/${repoName}`);

  // 1. Determine system platform and architecture
  const platform = os.platform();
  const arch = os.arch();

  const osIdentifier = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  if (!['win', 'osx', 'linux'].includes(osIdentifier)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const archIdentifier = arch === 'x64' ? 'x64' : 'arm64';
  if (!['x64', 'arm64'].includes(archIdentifier)) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  console.log(`Detected system: ${osIdentifier}-${archIdentifier}`);

  // 2. Fetch latest release data from GitHub API
  const releaseUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
  let releaseData: GitHubRelease;
  try {
    console.log(`Fetching latest release info from: ${releaseUrl}`);
    releaseData = await fetchJson<GitHubRelease>(releaseUrl);
    console.log(`Successfully fetched release: ${releaseData.tag_name}`);
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error(`Error fetching latest release from ${releaseUrl}:`, errorMessage);

    // If fetching fails due to a rate limit, try to fall back to a local version.
    if (errorMessage.toLowerCase().includes('403')) {
      console.warn('GitHub API rate limit exceeded. Checking for existing local versions as a fallback.');
      try {
        const dirents = await fsPromises.readdir(baseDestinationDir, {withFileTypes: true});
        // Filter for directories, map to their names (versions), and sort them.
        // Using localeCompare with numeric: true ensures correct sorting for version strings like 'v1.10.0' vs 'v1.2.0'.
        const versionDirs = dirents
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name)
          .sort((a, b) => b.localeCompare(a, undefined, {numeric: true, sensitivity: 'base'}));

        if (versionDirs.length > 0) {
          const latestLocalVersion = versionDirs[0];
          const fallbackPath = path.join(baseDestinationDir, latestLocalVersion);
          console.log(`Found existing local version. Using latest available '${latestLocalVersion}' as a fallback.`);
          return fallbackPath;
        }

        console.error(`API rate limit exceeded and no local versions of ${cliName} found in ${baseDestinationDir}.`);
        throw new Error(`API rate limit exceeded and no local versions of ${cliName} are available.`);
      } catch (fsError: any) {
        if (fsError.code === 'ENOENT') {
          console.error(`API rate limit exceeded and the destination directory ${baseDestinationDir} does not exist.`);
        } else {
          console.error('An unexpected error occurred while finding a local fallback:', fsError.message);
        }
        throw new Error(`API rate limit exceeded and no local versions of ${cliName} are available.`);
      }
    }

    // For other non-rate-limit errors, fail as before.
    throw new Error(`Failed to fetch latest release info for ${repoOwner}/${repoName}.`);
  }

  if (!releaseData?.assets?.length) {
    throw new Error(`No assets found in the latest release for ${repoOwner}/${repoName}.`);
  }

  const versionString = releaseData.tag_name;
  const finalExtractionPath = path.resolve(baseDestinationDir, versionString);

  // Check if the latest version already exists
  try {
    await fsPromises.access(finalExtractionPath);
    console.log(`Latest version '${versionString}' already exists. Skipping download.`);
    await cleanupOldVersions(baseDestinationDir, versionString, cliName);
    return finalExtractionPath;
  } catch {
    // Directory doesn't exist, proceed with download.
    console.log(`New version '${versionString}' not found locally. Proceeding with download.`);
  }

  // 3. Find the target asset
  const expectedAssetName = `${cliName}-${osIdentifier}-${archIdentifier}-${versionString}.zip`;
  const targetAsset = releaseData.assets.find(asset => asset.name.toLowerCase() === expectedAssetName.toLowerCase());

  if (!targetAsset) {
    throw new Error(`Could not find asset "${expectedAssetName}" in release ${versionString}.`);
  }

  console.log(`Found asset: ${targetAsset.name}`);

  // 4. Download and extract
  const tempDownloadDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${cliName}-download-`));
  const zipFilePath = path.join(tempDownloadDir, targetAsset.name);

  try {
    console.log(`Downloading ${targetAsset.name} to ${zipFilePath}...`);
    await downloadFile(targetAsset.browser_download_url, zipFilePath);

    console.log(`Extracting ${zipFilePath} to ${finalExtractionPath}...`);
    await fsPromises.mkdir(finalExtractionPath, {recursive: true});
    await decompress(zipFilePath, finalExtractionPath);
    console.log('Extraction complete.');

    await cleanupOldVersions(baseDestinationDir, versionString, cliName);
  } catch (error) {
    console.error('An error occurred during download or extraction:', (error as Error).message);
    throw new Error(`Failed to download and extract ${targetAsset.name}.`);
  } finally {
    await fsPromises.rm(tempDownloadDir, {recursive: true, force: true});
  }

  console.log(`${cliName} successfully installed at ${finalExtractionPath}`);
  return finalExtractionPath;
}

/**
 * Downloads and extracts the latest version of the CLI tool to the specified directory.
 *
 * @param {string} targetDir - The base directory where the CLI tool should be saved (e.g., 'C:/Users/YourUser/AppData/Local/LynxHub/cli').
 * Versions will be stored in subdirectories like 'LynxHardwareCLI/v1.0.0'.
 * @return {Promise<void>} A promise that resolves when the CLI tool is successfully downloaded and validated.
 */
export default async function DownloadCli(targetDir: string): Promise<string> {
  const repoOwner = 'KindaBrazy';
  const repoName = 'LynxHardwareCLI';
  const cliName = 'LynxHardwareCLI';

  // The base directory where different versions of the CLI will be stored
  const cliBaseDir = path.join(targetDir, cliName);

  try {
    const extractedPath = await downloadAndExtractLatestCli(repoOwner, repoName, cliName, cliBaseDir);
    console.log(`CLI tool is ready at: ${extractedPath}`);

    const executableName = os.platform() === 'win32' ? `${cliName}.exe` : cliName;
    const executablePath = path.join(extractedPath, executableName);
    console.log(`Executable should be at: ${executablePath}`);

    // Verify the executable exists in the newly extracted or existing directory
    await fsPromises.access(executablePath, originalFs.constants.F_OK);
    console.log(`Executable ${executablePath} exists.`);
    return executablePath;
  } catch (error) {
    console.error('An error occurred during CLI download and setup:', (error as Error).message);
    throw error; // Re-throw the error for the caller to handle
  }
}
