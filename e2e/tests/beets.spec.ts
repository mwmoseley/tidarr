import { expect } from "@playwright/test";

import { test } from "../test-isolation";

test.use({ envFile: ".env.e2e.beets" });

test("Beets: Should report beets as enabled and mask the Discogs token", async ({
  page,
}) => {
  await page.goto("/parameters");

  await page.getByRole("tab", { name: "Env vars" }).click();

  const table = page.getByLabel("simple table").filter({ hasText: "Variable" });

  await expect(
    table.locator("tr", { hasText: "ENABLE_BEETS" }).locator("td").last(),
  ).toContainText("true");

  await expect(
    table.locator("tr", { hasText: "DISCOGS_TOKEN" }).locator("td").last(),
  ).toContainText("****");

  // The token is a personal access token: it must never reach the client, so
  // assert on the whole page rather than just the cell that masks it
  await expect(page.locator("body")).not.toContainText("e2e-discogs-token");
});

test("Beets: Should ship the plugins the import flow relies on", async ({
  tidarrContainer,
}) => {
  // The import flow autotags with -C and leans on acoustid fingerprinting for
  // the tracks MusicBrainz cannot match on metadata alone, while Discogs is
  // what supplies genres/styles. Both arrive as extras in
  // docker/requirements.txt, which is easy to lose in a rebase - and a missing
  // plugin surfaces only as a silent tagging regression at run time.
  const beetVersion = await tidarrContainer.exec([
    "beet",
    "-c",
    "/shared/beets-config.yml",
    "version",
  ]);

  expect(beetVersion.exitCode).toBe(0);
  // Listed in the shipped config, so it must actually load
  expect(beetVersion.output).toContain("chroma");

  // Discogs is not in the shipped config - it is enabled at run time only when
  // DISCOGS_TOKEN is set - so check the plugin is importable instead
  const discogs = await tidarrContainer.exec([
    "python3",
    "-c",
    "import beetsplug.discogs",
  ]);

  expect(discogs.exitCode).toBe(0);
});
