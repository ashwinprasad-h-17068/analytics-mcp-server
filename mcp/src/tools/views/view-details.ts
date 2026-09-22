import { z } from "zod";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient } from "../../utils/apiUtil";
import { ToolResponse, logAndReturnError } from "../../utils/common";

// ---- Tool Registration ----

defineTool({
  name: "getViewDetails",
  description: `
    <use_case>
      1) Fetches the details of a specific view in a workspace.
      2) Use this when you need detailed information about a specific view, such as its structure, data, and properties.
         (In case of a table, it will return the columns and their data types; dashboards will return the charts and their properties, etc.)
    </use_case>

    <returns>
      A dictionary containing the details of the specified view.
      If an error occurs, returns an error message.
    </returns>
  `,
  args: {
    viewId: z.string().describe("The ID of the view for which to fetch details"),
  },
  handler: async ({ viewId }) => {
    try {
      const analyticsClient = getAnalyticsClient();
      const viewDetails = await analyticsClient.getViewDetails(viewId, { withInvolvedMetaInfo: true });
      if (viewDetails) {
        if ("orgId" in viewDetails) delete (viewDetails as any).orgId;
        if ("createdByZuId" in viewDetails) delete (viewDetails as any).createdByZuId;
        if ("lastDesignModifiedByZuId" in viewDetails) delete (viewDetails as any).lastDesignModifiedByZuId;

        if ("columns" in viewDetails && Array.isArray((viewDetails as any).columns)) {
          (viewDetails as any).columns = (viewDetails as any).columns.map((column: any) => {
            const col = { ...column };
            delete col.dataTypeId;
            delete col.columnIndex;
            delete col.pkTableName;
            delete col.pkColumnName;
            delete col.formulaDisplayName;
            delete col.defaultValue;
            return col;
          });
        }
      }
      return ToolResponse(`Retrieved details for view ID: ${viewId}\n${JSON.stringify(viewDetails)}`);
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching view details");
    }
  },
});
