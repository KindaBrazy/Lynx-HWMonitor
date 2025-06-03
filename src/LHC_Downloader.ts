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
 * Downloads and extracts a CLI tool from the latest GitHub release.
 *
 * @param repoOwner The owner of the GitHub repository.
 * @param repoName The name of the GitHub repository.
 * @param cliName The base name of the CLI tool.
 * @param destinationDir The directory where the CLI tool's files will be extracted.
 * This directory will be created if it doesn't exist.
 * @returns A promise that resolves to the path of the directory where files were extracted.
 * @throws Will throw an error if any step fails (e.g., network issue, asset not found, extraction error).
 */
async function downloadAndExtractLatestCli(
  repoOwner: string,
  repoName: string,
  cliName: string,
  destinationDir: string,
): Promise<string> {
  const finalExtractionPath = path.resolve(destinationDir);

  // Check if the CLI tool already exists in the destination directory
  try {
    const stats = await fsPromises.stat(finalExtractionPath);
    if (stats.isDirectory()) {
      // You might want to add a more robust check here, e.g.,
      // check for the presence of a specific executable file or a version file
      console.log(
        `CLI tool '${cliName}' already appears to be extracted in '${finalExtractionPath}'. Skipping download.`,
      );
      return finalExtractionPath;
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log(`CLI tool '${cliName}' not found in '${finalExtractionPath}'. Proceeding with download.`);
      // Directory doesn't exist, proceed with download
    } else {
      console.error(`Error checking existence of ${finalExtractionPath}:`, error.message);
      throw error; // Re-throw other errors
    }
  }

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

  // 3. Construct the target asset name and find the asset
  const versionString = releaseData.tag_name;
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
 * @param {string} saveTo - The directory where the CLI tool should be saved.
 * @return {Promise<void>} A promise that resolves when the CLI tool is successfully downloaded and validated.
 */
export default async function DownloadCli(saveTo: string): Promise<void> {
  const repoOwner = 'KindaBrazy';
  const repoName = 'LynxHardwareCLI';
  const cliName = 'LynxHardwareCLI';

  const specificToolDir = path.join(saveTo, cliName);

  try {
    const extractedPath = await downloadAndExtractLatestCli(repoOwner, repoName, cliName, specificToolDir);
    console.log(`CLI tool is ready at: ${extractedPath}`);

    const executableName = os.platform() === 'win32' ? `${cliName}.exe` : cliName;
    const executablePath = path.join(extractedPath, executableName);
    console.log(`Executable should be at: ${executablePath}`);

    await fsPromises.access(executablePath, originalFs.constants.F_OK);
    console.log(`Executable ${executablePath} exists.`);
  } catch (error) {
    console.error('An error occurred in the main process:', (error as Error).message);
  }
}
