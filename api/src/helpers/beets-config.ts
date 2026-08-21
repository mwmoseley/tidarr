import fs from "fs";
import path from "path";

import { CONFIG_PATH } from "../../constants";

const BASE_CONFIG = path.join(CONFIG_PATH, "beets-config.yml");
const DERIVED_CONFIG = path.join(CONFIG_PATH, ".beets-config.generated.yml");

/**
 * Adds "discogs" to a beets `plugins` declaration.
 *
 * The shipped template uses the inline form ("plugins: a b c"), but a user is
 * free to rewrite it as a YAML flow list or a block list, so handle all three
 * rather than silently producing a config with the plugin missing.
 *
 * @param config - Raw beets config file contents
 * @returns The config with discogs enabled, or unchanged if it already was
 */
function enableDiscogsPlugin(config: string): string {
  const inline = config.match(/^plugins:[ \t]*(.*)$/m);
  if (!inline) return config;

  const value = inline[1].trim();

  // Already listed. Only look at the declaration itself - the plugins line
  // plus any block-list entries under it - so a comment mentioning discogs
  // elsewhere in the file does not count as enabling it.
  const lines = config.slice(config.indexOf(inline[0])).split("\n");
  let end = 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;

  const region = lines.slice(0, end).join("\n");

  if (/(^|[\s[,])discogs([\s\],]|$)/m.test(region)) return config;

  // Flow list: plugins: [a, b]
  if (value.startsWith("[")) {
    return config.replace(
      inline[0],
      inline[0].replace(/\]\s*$/, value === "[]" ? "discogs]" : ", discogs]"),
    );
  }

  // Block list: plugins: followed by "  - name" entries
  if (value === "") {
    return config.replace(inline[0], `${inline[0]}\n  - discogs`);
  }

  // Inline space-separated list
  return config.replace(inline[0], `${inline[0].trimEnd()} discogs`);
}

/**
 * Builds the beets config to run with.
 *
 * Discogs needs a personal access token, which does not belong in the config
 * file the user mounts and shares around, so it is injected from the
 * environment into a derived copy at run time. Without DISCOGS_TOKEN the
 * user's config is used untouched.
 *
 * @returns Path to the config file to pass to `beet -c`
 */
export function getBeetsConfigPath(): string {
  const token = process.env.DISCOGS_TOKEN;

  if (!token) {
    // Never leave a stale copy of the token lying around
    fs.rmSync(DERIVED_CONFIG, { force: true });
    return BASE_CONFIG;
  }

  try {
    const config = fs.readFileSync(BASE_CONFIG, "utf8");

    // A user who configured discogs themselves owns the settings - appending
    // a second block would give beets a duplicate key
    if (/^discogs:/m.test(config)) return BASE_CONFIG;

    // A YAML double-quoted scalar escapes like a JSON string
    const derived = [
      enableDiscogsPlugin(config).trimEnd(),
      "",
      "discogs:",
      `    user_token: ${JSON.stringify(token)}`,
      "",
    ].join("\n");

    fs.writeFileSync(DERIVED_CONFIG, derived, { mode: 0o600 });
    console.log("💿 [BEETS] Discogs enabled");

    return DERIVED_CONFIG;
  } catch (error: unknown) {
    console.error(
      `[ERROR] Could not enable Discogs for beets: ${(error as Error).message}`,
    );
    return BASE_CONFIG;
  }
}
