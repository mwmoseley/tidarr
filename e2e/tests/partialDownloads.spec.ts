import { expect, Page } from "@playwright/test";

import { test } from "../test-isolation";

import { mockItemOutputSSE, mockSSEPayload } from "./utils/mock";

const partialItem = {
  id: "77610756",
  title: "Nevermind",
  artist: "Nirvana",
  type: "album",
  quality: "high",
  status: "completed_with_errors",
  partialErrors: 3,
  loading: false,
};

const finishedItem = {
  id: "77610844",
  title: "In Utero",
  artist: "Nirvana",
  type: "album",
  quality: "high",
  status: "finished",
  loading: false,
};

async function mockProcessingSSE(page: Page, items: unknown[]) {
  await page.route("**/stream-processing", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: `data: ${mockSSEPayload(items)}\n\n`,
    });
  });
}

async function openProcessingList(page: Page) {
  await page.goto("/");
  await expect(page.locator("button.MuiFab-circular")).toBeVisible();
  await page.locator("button.MuiFab-circular").click();
  await page.waitForSelector('[aria-label="Processing table"]', {
    state: "visible",
    timeout: 5000,
  });
}

/**
 * Terminal items are grouped into the finished list, which is collapsed by
 * default behind a "Show finished (n)" toggle.
 */
async function showFinishedList(page: Page) {
  await page.getByRole("button", { name: /Show finished/i }).click();
}

test("Partial downloads: Should list a partially completed item as done", async ({
  page,
}) => {
  await mockItemOutputSSE(page, "high");
  await mockProcessingSSE(page, [partialItem, finishedItem]);

  await openProcessingList(page);

  // Both items are terminal, so the counter must read 2/2 - a partially
  // completed item must not leave the queue looking stuck at 1/2
  await expect(page.locator("button.MuiFab-circular")).toContainText("2/2");

  // ... and both belong to the finished group, not the active queue
  await expect(
    page.getByRole("button", { name: "Show finished (2)" }),
  ).toBeVisible();

  await showFinishedList(page);
  await expect(page.getByRole("main")).toContainText("Nevermind");
});

test("Partial downloads: Should offer a retry on a partially completed item", async ({
  page,
}) => {
  await mockItemOutputSSE(page, "high");
  await mockProcessingSSE(page, [partialItem]);

  await openProcessingList(page);
  await showFinishedList(page);

  // Retry is offered for partial items, same as for failed ones
  const retryButton = page.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeVisible();

  let saveCalled = false;
  await page.route("**/save", async (route) => {
    saveCalled = true;
    await route.fulfill({ status: 201 });
  });
  await page.route("**/remove", async (route) => {
    await route.fulfill({ status: 200 });
  });

  await retryButton.click();
  await page.waitForTimeout(500);

  // Guard against the retry silently no-oping for non-"error" statuses
  expect(saveCalled).toBe(true);
});
