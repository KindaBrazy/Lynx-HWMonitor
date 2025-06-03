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
 *
 * @param repoOwner The owner of the GitHub repository.
 * @param repoName The name of the GitHub repository.
 * @param cliName The base name of the CLI tool.
 * @param baseDestinationDir The base directory where the CLI tool's versions will be extracted.
 * This directory will be created if it doesn't exist.
 * @returns A promise that resolves to the path of the directory where files were extracted.
 * @throws Will throw an error if any step fails (e.g., network issue, asset not found, extraction error).
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

  let osIdentifier: string;
  switch (platform) {
    case 'win32':
      osIdentifier = 'win';
      break;
    case 'darwin':
      osIdentifier = 'osx';
      break;
    case 'linux':
      osIdentifier = 'linux';
      break;
    default:
      console.error(`Unsupported platform: ${platform}`);
      throw new Error(`Unsupported platform: ${platform}`);
  }

  let archIdentifier: string;
  switch (arch) {
    case 'x64':
      archIdentifier = 'x64';
      break;
    case 'arm64':
      archIdentifier = 'arm64';
      break;
    default:
      console.error(`Unsupported architecture: ${arch}`);
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
    console.error(`Error fetching latest release from ${releaseUrl}:`, (error as Error).message);
    throw new Error(`Failed to fetch latest release info for ${repoOwner}/${repoName}.`);
  }

  if (!releaseData || !releaseData.assets || releaseData.assets.length === 0) {
    console.error('No assets found in the latest release.');
    throw new Error(`No assets found in the latest release for ${repoOwner}/${repoName}.`);
  }

  const versionString = releaseData.tag_name;

  const finalExtractionPath = path.resolve(baseDestinationDir, versionString);

  // Check if the latest version already exists
  try {
    const stats = await fsPromises.stat(finalExtractionPath);
    if (stats.isDirectory()) {
      console.log(
        `Latest CLI tool '${cliName}' version '${versionString}' already extracted in '${finalExtractionPath}'. Skipping download.`,
      );
      // Clean up old versions even if the latest is already present
      await cleanupOldVersions(baseDestinationDir, versionString, cliName);
      return finalExtractionPath;
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log(
        `Latest CLI tool '${cliName}' version '${versionString}' not found in '${finalExtractionPath}'. Proceeding with download.`,
      );
      // Directory doesn't exist, proceed with download
    } else {
      console.error(`Error checking existence of ${finalExtractionPath}:`, error.message);
      throw error; // Re-throw other errors
    }
  }

  // If we reach here, the latest version needs to be downloaded/extracted
  console.log(`New version '${versionString}' available or not found. Proceeding with download.`);

  // 3. Construct the target asset name and find the asset
  const expectedAssetName = `${cliName}-${osIdentifier}-${archIdentifier}-${versionString}.zip`;
  console.log(`Looking for asset: ${expectedAssetName}`);

  const targetAsset = releaseData.assets.find(asset => asset.name.toLowerCase() === expectedAssetName.toLowerCase());

  if (!targetAsset) {
    console.error(
      `Could not find asset "${expectedAssetName}". Available assets:`,
      releaseData.assets.map(a => a.name),
    );
    throw new Error(`Could not find asset "${expectedAssetName}" in release ${versionString}.`);
  }
  console.log(`Found asset: ${targetAsset.name}`);

  // 4. Download the asset
  const downloadUrl = targetAsset.browser_download_url;
  const tempDownloadDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${cliName}-download-`));
  const zipFilePath = path.join(tempDownloadDir, targetAsset.name);

  try {
    console.log(`Downloading ${targetAsset.name} from ${downloadUrl} to ${zipFilePath}...`);
    await downloadFile(downloadUrl, zipFilePath);
    console.log(`Download complete: ${zipFilePath}`);
  } catch (error) {
    console.error(`Error downloading asset "${targetAsset.name}":`, (error as Error).message);
    await fsPromises
      .rm(tempDownloadDir, {recursive: true, force: true})
      .catch(e => console.error('Error cleaning temp dir:', e));
    throw new Error(`Failed to download ${targetAsset.name}.`);
  }

  // 5. Extract the ZIP file
  console.log(`Ensuring extraction directory exists: ${finalExtractionPath}`);
  await fsPromises.mkdir(finalExtractionPath, {recursive: true});

  try {
    console.log(`Extracting ${zipFilePath} to ${finalExtractionPath}...`);
    await decompress(zipFilePath, finalExtractionPath);
    console.log('Extraction complete.');

    // After successful extraction, clean up old versions
    await cleanupOldVersions(baseDestinationDir, versionString, cliName);
  } catch (error) {
    console.error(`Error extracting ZIP file "${zipFilePath}" to "${finalExtractionPath}":`, (error as Error).message);
    throw new Error(`Failed to extract ${targetAsset.name} to ${finalExtractionPath}.`);
  } finally {
    console.log(`Cleaning up temporary download directory: ${tempDownloadDir}`);
    await fsPromises
      .rm(tempDownloadDir, {recursive: true, force: true})
      .catch(e => console.error('Error cleaning temp dir:', e));
  }

  console.log(`${cliName} has been successfully downloaded and extracted to ${finalExtractionPath}`);
  return finalExtractionPath;
}

/**
 * Downloads and extracts the latest version of the CLI tool to the specified directory.
 *
 * @param {string} targetDir - The base directory where the CLI tool should be saved (e.g., 'C:/Users/YourUser/AppData/Local/LynxHub/cli').
 * Versions will be stored in subdirectories like 'LynxHardwareCLI/v1.0.0'.
 * @return {Promise<void>} A promise that resolves when the CLI tool is successfully downloaded and validated.
 */
export default async function DownloadCli(targetDir: string): Promise<void> {
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
  } catch (error) {
    console.error('An error occurred during CLI download and setup:', (error as Error).message);
    throw error; // Re-throw the error for the caller to handle
  }
}
