import { ProcessingItemType } from "../types";

/**
 * Terminal "the download is over and files were kept" statuses.
 * "completed_with_errors" counts as done: its successful tracks went through
 * the full post-processing flow and are in the library.
 */
export function isDownloadDone(status: ProcessingItemType["status"]): boolean {
  return status === "finished" || status === "completed_with_errors";
}

export function a11yProps(index: number) {
  return {
    id: `full-width-tab-${index}`,
    "aria-controls": `full-width-tabpanel-${index}`,
  };
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);

  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
  };

  const formatter = new Intl.DateTimeFormat(
    navigator.language || "en-US",
    options,
  );
  return formatter.format(date);
}
