// filepath: /home/ashwin-17068/zr-repos/zoho_analytics_mcp/node/src/tools/row-tools.ts
import { z } from "zod";
import type { ServerInstance } from "../common";
import { getAnalyticsClient, config } from '../utils/apiUtil';

export function registerRowTools(server: ServerInstance) {

    server.registerTool("add_row",
    {
        description: `
        <use_case>
        Adds a new row to the specified table.
        </use_case>

        <arguments>
        - workspaceId: The ID of the workspace where the table is located.
        - tableId: The ID of the table to which the row will be added.
        - columns: A dictionary containing the column names and their corresponding values for the new row.
        </arguments>
        `,
        inputSchema: {
            workspaceId: z.string().describe("The ID of the workspace where the table is located"),
            tableId: z.string().describe("The ID of the table to which the row will be added"),
            columns: z.record(z.string(), z.string()).describe("A dictionary containing the column names and their corresponding values for the new row")
        }
    },
    async ({ workspaceId, tableId, columns }) => {
        try {
            const analyticsClient = getAnalyticsClient();
            const view = analyticsClient.getViewInstance(config.ORGID || "", workspaceId, tableId);
            await view.addRow(columns);
            
            return {
                content: [{ 
                    type: "text", 
                    text: "Row added successfully." 
                }]
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `Error while adding row: ${errorMessage}` 
                }]
            };
        }
    });

    server.registerTool("delete_rows",
    {
        description: `
        <use_case>
        Deletes rows from the specified table based on the given criteria.
        </use_case>

        <arguments>
        - workspaceId: The ID of the workspace where the table is located.
        - tableId: The ID of the table from which rows will be deleted.
        - criteria: A string representing the criteria for selecting rows to delete.
            Example criteria: "\"SalesTable\".\"Region\"='East'"
        </arguments>
        `,
        inputSchema: {
            workspaceId: z.string().describe("The ID of the workspace where the table is located"),
            tableId: z.string().describe("The ID of the table from which rows will be deleted"),
            criteria: z.string().describe("A string representing the criteria for selecting rows to delete. Example criteria: \"\\\"SalesTable\\\".\\\"Region\\\"='East'\"")
        }
    },
    async ({ workspaceId, tableId, criteria }) => {
        try {
            const analyticsClient = getAnalyticsClient();
            const view = analyticsClient.getViewInstance(config.ORGID || "", workspaceId, tableId);
            await view.deleteRow(criteria);
            
            return {
                content: [{ 
                    type: "text", 
                    text: "Rows deleted successfully." 
                }]
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `Error while deleting rows: ${errorMessage}` 
                }]
            };
        }
    });

    server.registerTool("update_rows",
    {
        description: `
        <use_case>
        Updates rows in the specified table based on the given criteria.
        </use_case>

        <arguments>
        - workspaceId: The ID of the workspace where the table is located.
        - tableId: The ID of the table to be updated.
        - columns: A dictionary containing the column names and their new values for the update.
        - criteria: A string representing the criteria for selecting rows to update.
            Example criteria: "\"SalesTable\".\"Region\"='East'"
        </arguments>
        `,
        inputSchema: {
            workspaceId: z.string().describe("The ID of the workspace where the table is located"),
            tableId: z.string().describe("The ID of the table to be updated"),
            columns: z.record(z.string(), z.string()).describe("A dictionary containing the column names and their new values for the update"),
            criteria: z.string().describe("A string representing the criteria for selecting rows to update. Example criteria: \"\\\"SalesTable\\\".\\\"Region\\\"='East'\"")
        }
    },
    async ({ workspaceId, tableId, columns, criteria }) => {
        try {
            const analyticsClient = getAnalyticsClient();
            const view = analyticsClient.getViewInstance(config.ORGID || "", workspaceId, tableId);
            await view.updateRow(columns, criteria);
            
            return {
                content: [{ 
                    type: "text", 
                    text: "Rows updated successfully." 
                }]
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `Error while updating rows: ${errorMessage}` 
                }]
            };
        }
    });
}