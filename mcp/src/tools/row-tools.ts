import { z } from "zod";
import { defineTool } from "../tool-registry";
import { getAnalyticsClient, config } from "../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";

// ---- Tool Registrations ----

defineTool({
  name: "addRow",
  description: `
    <use_case>
    Adds a new row to the specified table.
    </use_case>
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace where the table is located"),
    tableId: z.string().describe("The ID of the table to which the row will be added"),
    columns: z
      .record(z.string(), z.string())
      .describe("A dictionary containing the column names and their corresponding values for the new row"),
  },
  handler: async ({ workspaceId, tableId, columns }) => {
    try {
      const orgId = config.ORGID || "";
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, table, cols) => {
          const analyticsClient = getAnalyticsClient();
          const view = analyticsClient.getViewInstance(org_id, workspace, table);
          await view.addRow(cols);
          return ToolResponse("Row added successfully.");
        },
        workspaceId,
        tableId,
        columns
      );
    } catch (err) {
      return logAndReturnError(err, "Error while adding row");
    }
  },
});

defineTool({
  name: "deleteRows",
  description: `
    <use_case>
    Deletes rows from the specified table based on the given criteria.
    </use_case>
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace where the table is located"),
    tableId: z.string().describe("The ID of the table from which rows will be deleted"),
    criteria: z
      .string()
      .describe(
        "A string representing the criteria for selecting rows to delete. Example criteria: \"\\\"SalesTable\\\".\\\"Region\\\"='East'\""
      ),
  },
  handler: async ({ workspaceId, tableId, criteria }) => {
    try {
      const orgId = config.ORGID || "";
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, table, crit) => {
          const analyticsClient = getAnalyticsClient();
          const view = analyticsClient.getViewInstance(org_id, workspace, table);
          await view.deleteRow(crit);
          return ToolResponse("Rows deleted successfully.");
        },
        workspaceId,
        tableId,
        criteria
      );
    } catch (err) {
      return logAndReturnError(err, "Error while deleting rows");
    }
  },
});

defineTool({
  name: "updateRows",
  description: `
    <use_case>
    Updates rows in the specified table based on the given criteria.
    </use_case>
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace where the table is located"),
    tableId: z.string().describe("The ID of the table to be updated"),
    columns: z
      .record(z.string(), z.string())
      .describe("A dictionary containing the column names and their new values for the update"),
    criteria: z
      .string()
      .describe(
        "A string representing the criteria for selecting rows to update. Example criteria: \"\\\"SalesTable\\\".\\\"Region\\\"='East'\""
      ),
  },
  handler: async ({ workspaceId, tableId, columns, criteria }) => {
    try {
      const orgId = config.ORGID || "";
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, table, crit, cols) => {
          const analyticsClient = getAnalyticsClient();
          const view = analyticsClient.getViewInstance(org_id, workspace, table);
          await view.updateRow(cols, crit);
          return ToolResponse("Rows updated successfully.");
        },
        workspaceId,
        tableId,
        criteria,
        columns
      );
    } catch (err) {
      return logAndReturnError(err, "Error while updating rows");
    }
  },
});
