import { z } from "zod";
import { defineTool } from "../../../tool-registry";
import { getAnalyticsClient, config } from "../../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../../utils/common";

// ---- Tool Registration ----

defineTool({
  name: "createTable",
  description: "Create a new table in the given workspace with the given name",
  args: {
    workspaceId: z.string().describe("The ID of the workspace in which to create the table"),
    tableName: z.string().describe("The name of the table to create"),
    columnsArr: z
      .array(
        z.object({
          columnName: z.string().describe("The name of the column"),
          dataType: z
            .enum(["PLAIN", "NUMBER", "DATE", "EMAIL", "CURRENCY", "URL", "POSITIVE_NUMBER", "DECIMAL_NUMBER"])
            .describe("The data type of the column"),
        })
      )
      .describe("A list of column definitions for the table"),
  },
  handler: async ({ workspaceId, tableName, columnsArr }) => {
    try {
      const orgId = config.ORGID || "";
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, tableAlias, cols_arr) => {
          const tableDesign = {
            TABLENAME: tableAlias,
            COLUMNS: cols_arr.map((c: { columnName: string; dataType: string }) => ({
              COLUMNNAME: c.columnName,
              DATATYPE: c.dataType,
            })),
          };
          const analyticsClient = getAnalyticsClient();
          const workspaceInst = analyticsClient.getWorkspaceInstance(org_id, workspace);
          const tableId = await workspaceInst.createTable(tableDesign);
          return ToolResponse(`Table '${tableName}' created successfully. Table Id: ${tableId}`);
        },
        workspaceId,
        tableName,
        columnsArr
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while creating the table");
    }
  },
});
