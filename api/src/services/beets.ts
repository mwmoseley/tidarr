import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { CONFIG_PATH, PROCESSING_PATH } from "../../constants";
import { getAppInstance } from "../helpers/app-instance";
import { logs } from "../processing/utils/logs";
import { ContentType, ProcessingItemType } from "../types";

// Extensions tiddl can produce for audio. Anything else (covers, .lrc, .m3u)
// is ignored when working out what a folder contains.
const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".aac",
]);

// Content types whose folders are always complete releases, and those whose
// folders are always fragments. tiddl gives playlist tracks the same
// "<artist>/<year> - <album>/<NN>. <title>" layout as an album download, so
// the item type is the only reliable signal - filenames alone cannot tell a
// one-track playlist pick apart from a genuine single-track release.
const ALBUM_CONTENT_TYPES = new Set<ContentType>([
  "album",
  "artist",
  "favorite_albums",
  "favorite_artists",
]);

const SINGLETON_CONTENT_TYPES = new Set<ContentType>([
  "track",
  "playlist",
  "mix",
  "favorite_tracks",
  "favorite_playlists",
]);

type ImportPaths = {
  albums: string[];
  singletons: string[];
};

/**
 * Collects every folder under a path that directly contains audio files.
 * @param root - Folder to walk
 * @returns Map of folder path to the audio filenames it holds
 */
function collectAudioFolders(root: string): Map<string, string[]> {
  const folders = new Map<string, string[]>();

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const audioFiles: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        audioFiles.push(entry.name);
      }
    }

    if (audioFiles.length > 0) {
      folders.set(dir, audioFiles);
    }
  };

  walk(root);

  return folders;
}

/**
 * Decides whether a folder holds a complete album or loose tracks.
 *
 * tiddl names files with a leading track number ("07. Polly"), so a folder
 * whose numbers run contiguously from 1 is a full album, while a sparse set
 * ("07." on its own) is a fragment pulled out of an album by a playlist or
 * mix download and should be tagged as singletons instead.
 *
 * Repeated numbers mean a multi-disc release (per_disc_numbering restarts the
 * count on each disc), which is still an album.
 *
 * @param files - Audio filenames in the folder
 * @returns true when the folder should be imported as an album
 */
function isCompleteAlbum(files: string[]): boolean {
  // A lone file is a fragment, never a release: a playlist pick that happens
  // to be track 1 of its album would otherwise pass the contiguity check below
  // and get tagged with the whole release it was lifted from.
  if (files.length < 2) return false;

  const numbers: number[] = [];

  for (const file of files) {
    const match = file.match(/^(\d+)[.\s-]/);
    // Template has no track number - fall back to album mode (previous behaviour)
    if (!match) return true;
    numbers.push(parseInt(match[1], 10));
  }

  const unique = new Set(numbers);
  // Multi-disc: numbering restarts per disc
  if (unique.size !== numbers.length) return true;

  const sorted = [...numbers].sort((a, b) => a - b);

  return sorted[0] === 1 && sorted[sorted.length - 1] === sorted.length;
}

/**
 * Decides how a single downloaded folder should be imported.
 *
 * The content type settles it outright for everything a user can queue; the
 * filename heuristic is only a fallback for types that produce a mix of both
 * (or for a type added later that is not listed above).
 *
 * @param type - Content type of the queued item
 * @param files - Audio filenames in the folder
 * @returns true when the folder should be imported as an album
 */
function isAlbumFolder(type: ContentType, files: string[]): boolean {
  if (SINGLETON_CONTENT_TYPES.has(type)) return false;
  if (ALBUM_CONTENT_TYPES.has(type)) return true;

  return isCompleteAlbum(files);
}

/**
 * Splits an item's downloaded folders into album imports and singleton imports
 * @param root - The item's processing folder
 * @param type - Content type of the queued item
 */
export function classifyImportPaths(
  root: string,
  type: ContentType,
): ImportPaths {
  const albums: string[] = [];
  const singletons: string[] = [];

  for (const [folder, files] of collectAudioFolders(root)) {
    if (isAlbumFolder(type, files)) {
      albums.push(folder);
    } else {
      singletons.push(folder);
    }
  }

  return { albums, singletons };
}

function spawnBeet(
  itemId: string,
  command: string,
  additionalArgs: string[] = [],
): Promise<void> {
  const binary = "beet";
  const args = [
    "-c",
    `${CONFIG_PATH}/beets-config.yml`,
    "-l",
    `${CONFIG_PATH}/beets/beets-library.blb`,
    command,
    ...additionalArgs,
  ];

  console.log(`${binary} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const beetProcess = spawn(binary, args);

    beetProcess.stdout?.on("data", (data: Buffer) => {
      const stdout = data.toString("utf8");
      console.log(stdout);
    });

    beetProcess.stderr?.on("data", (data: Buffer) => {
      const stderr = data.toString("utf8");
      console.error(stderr);
      if (stderr.trim()) {
        logs(itemId, `⚠️ [BEETS] ${stderr.trim()}`);
      }
    });

    beetProcess.on("close", (code) => {
      if (code === 0) {
        logs(itemId, `✅ [BEETS] ${command} success`);
        resolve();
      } else {
        reject(new Error(`Beets ${command} exited with code ${code}`));
      }
    });

    beetProcess.on("error", (error) => {
      reject(error);
    });
  });
}

export async function beets(id: string): Promise<void> {
  const app = getAppInstance();
  const item: ProcessingItemType =
    app.locals.processingStack.actions.getItem(id);

  if (!item || item.type === "video") return;

  const itemProcessingPath = `${PROCESSING_PATH}/${item.id}`;

  try {
    // BEETS
    if (process.env.ENABLE_BEETS === "true") {
      logs(item.id, "🕖 [BEETS] Running ...", { skipConsole: true });
      console.log("--------------------");
      console.log("🎧 BEETS             ");
      console.log("--------------------");

      // Import complete albums and loose tracks separately: matching a
      // playlist fragment against a full release produces bad tags
      const { albums, singletons } = classifyImportPaths(
        itemProcessingPath,
        item.type,
      );

      if (albums.length === 0 && singletons.length === 0) {
        // Nothing recognisable - let beets walk the folder itself
        await spawnBeet(item.id, "import", ["-qC", itemProcessingPath]);
      } else {
        if (albums.length > 0) {
          logs(item.id, `🎧 [BEETS] Importing ${albums.length} album(s)`, {
            skipConsole: true,
          });
          await spawnBeet(item.id, "import", ["-qC", ...albums]);
        }

        if (singletons.length > 0) {
          logs(
            item.id,
            `🎧 [BEETS] Importing ${singletons.length} folder(s) as singletons`,
            { skipConsole: true },
          );
          await spawnBeet(item.id, "import", ["-qC", "-s", ...singletons]);
        }
      }

      // Run beet write after import
      logs(item.id, "🕖 [BEETS] Writing tags ...", { skipConsole: true });
      console.log("--------------------");
      console.log("🏷️  BEETS WRITE      ");
      console.log("--------------------");

      await spawnBeet(item.id, "write", [itemProcessingPath]);
    }
  } catch (err: unknown) {
    logs(
      item.id,
      `❌ [BEETS] Error during Beets processing :\r\n${(err as Error).message}`,
    );
  }
}
