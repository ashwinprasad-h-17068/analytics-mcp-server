import { z } from "zod";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";

defineTool({
  name: "deleteView",
  description: `
    Delete a view (table, report, or dashboard) in the specified workspace.
  `,
  args: {
    workspaceId: z
      .string()
      .describe("The ID of the workspace containing the view to delete"),
    viewId: z.string().describe("The ID of the view to delete"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided"),
  },
  handler: async ({ workspaceId, viewId, orgId }) => {
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
          await (workspaceInst as any).deleteView(viewId);
          return ToolResponse(`View '${viewId}' deleted successfully.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while deleting the view");
    }
  },
});
