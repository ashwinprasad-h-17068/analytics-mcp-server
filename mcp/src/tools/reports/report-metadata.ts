import { z } from "zod";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";

// ---- Tool Registration ----

defineTool({
  name: "readReportMetadata",
  description: `
    1. Use Case:
    - Retrieve the full visual metadata (design configuration) of an existing report in Zoho Analytics.
    - Supports all report types: chart, pivot, and summary.

    2. Important Notes:
    - This is a read-only operation; it does not modify the report in any way.
    - The returned metadata includes the report's title, reportType, chartType (for chart reports),
      axisColumns, filters, and userFilters — the complete design configuration of the report.
    - Always call this tool first before updating a report (e.g., via the updateReport tool), because
      the update endpoint performs a full replacement of the axis, filter, and user-filter configuration.
      Inspect the current configuration here, modify the desired fields, then re-submit via the update tool.

    3. Arguments:
    - workspaceId (str): The ID of the workspace containing the report.
    - reportId (str): The ID of the report whose metadata should be retrieved.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - A JSON string containing the report metadata, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the report"),
    reportId: z.string().describe("The ID of the report whose metadata to retrieve"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, reportId, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace) => {
          const ac = getAnalyticsClient();
          const workspaceInst = ac.getWorkspaceInstance(org_id, workspace);
          const metadata = await (workspaceInst as any).getReportMetadata(reportId);
          return ToolResponse(JSON.stringify(metadata, null, 2));
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while retrieving the report metadata");
    }
  },
});
