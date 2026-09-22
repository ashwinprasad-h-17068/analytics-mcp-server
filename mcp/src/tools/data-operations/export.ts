import { z } from "zod";
import path from "path";
import fs from "fs";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";
import {
  pollJobCompletion,
  QUERY_DATA_POLLING_INTERVAL,
  QUERY_DATA_QUEUE_TIMEOUT,
  QUERY_DATA_QUERY_EXECUTION_TIMEOUT,
} from "../../utils/data-util";

// ---- Tool Registration ----

defineTool({
  name: "exportData",
  description: `
    Exports a view from a Zoho Analytics workspace to a CSV file on the server.

    Use Cases:
    - Export a table, report, or other view data to a file for further processing or archiving.
    - Take a snapshot of a view's data and save it to the server's configured export directory.

    Important Notes:
    - Exports are saved in CSV format to the server's configured ALLOWED_FILE_ROOT directory.
    - First attempts a synchronous export. If that fails (e.g., for views not supported by
      the synchronous API such as tables with more than one million rows, live connect views,
      dashboards, or query tables), automatically falls back to the asynchronous export API.
    - Returns the full file path where the exported data was saved.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the view to export"),
    viewId: z.string().describe("The ID of the view to export"),
  },
  handler: async ({ workspaceId, viewId }) => {
    try {
      return await retryWithFallback(
        [config.ORGID || ""],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, view) => {
          const allowedFileRoot = process.env.ALLOWED_FILE_ROOT;
          if (!allowedFileRoot) {
            throw new Error(
              "The ALLOWED_FILE_ROOT environment variable is not configured. " +
                "It is required for the exportData tool to work properly. " +
                "Please set ALLOWED_FILE_ROOT to a writable directory."
            );
          }

          const analyticsClient = getAnalyticsClient();
          const bulk = analyticsClient.getBulkInstance(org_id, workspace);

          const exportDir = path.join(allowedFileRoot, "exports");
          fs.mkdirSync(exportDir, { recursive: true });
          const filePath = path.join(exportDir, `export_${view}_${Date.now()}.csv`);

          try {
            await bulk.exportData(view, "csv", filePath);
            return ToolResponse(`View exported successfully. File saved to: ${filePath}`);
          } catch {
            // Sync export not supported for this view — fall back to async export
            const jobId = await bulk.initiateBulkExport(view, "csv");

            const statusMessages: Record<string, string> = {
              error: "An internal error occurred during the async export job. Please try again later.",
              queue_timeout: "Export job accepted, but queue processing is slow. Please try again later.",
              execution_timeout: "Export job is taking too long to complete. Please try again later.",
            };

            const errorMessage = await pollJobCompletion(
              bulk,
              jobId,
              statusMessages,
              QUERY_DATA_POLLING_INTERVAL,
              QUERY_DATA_QUEUE_TIMEOUT,
              QUERY_DATA_QUERY_EXECUTION_TIMEOUT
            );

            if (errorMessage) throw new Error(errorMessage);

            await bulk.exportBulkData(jobId, filePath);
            return ToolResponse(`View exported successfully. File saved to: ${filePath}`);
          }
        },
        workspaceId,
        viewId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while exporting the view");
    }
  },
});
