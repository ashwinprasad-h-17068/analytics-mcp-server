import { z } from "zod";
import type { ServerInstance } from "../common";
import {getAnalyticsClient, config } from '../utils/apiUtil';
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";

export function registerModellingTools(server: ServerInstance) {

    server.registerTool("create_workspace",
    {
        description: "Create a new workspace in Zoho Analytics with the given name",
        inputSchema: { 
        workspaceName: z.string().describe("Name of the workspace to create")
        }
    },
    async ({ workspaceName }) => {
        try {
            const ac = getAnalyticsClient();
            const org = ac.getOrgInstance(config.ORGID || "");
            const configParam = {};
            const workspaceId = await org.createWorkspace(workspaceName, configParam);
            return ToolResponse(`Workspace '${workspaceName}' created successfully. Workspace Id: ${workspaceId}`);
        } catch (err) {
            return logAndReturnError(err, "An error occurred while creating the workspace");
        }
    });


    server.registerTool("create_table",
    {
        description: "Create a new table in the given workspace with the given name",
        inputSchema: { 
            workspaceId: z.string().describe("The ID of the workspace in which to create the table"),
            tableName: z.string().describe("The name of the table to create"),
            columns_arr: z.array(z.object({
                COLUMNNAME: z.string().describe("The name of the column"),
                DATATYPE: z.enum(["PLAIN", "NUMBER", "DATE"]).describe("The data type of the column")
            })).describe("A list of column definitions for the table"),
            orgId: z.string().optional().describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided.")
        }
    },
    async ({ workspaceId, tableName, columns_arr, orgId }) => {
        try {
            if (!orgId) {
                orgId = config.ORGID || "";
            }
            return await retryWithFallback([orgId], workspaceId, "WORKSPACE", async (orgId, workspace, tableAlias, cols_arr) => {
                const tableDesign = {
                    TABLENAME: tableAlias,
                    COLUMNS: cols_arr
                };
                const analyticsClient = getAnalyticsClient();
                const workspaceInst = analyticsClient.getWorkspaceInstance(config.ORGID || "", workspace);
                const tableId = await workspaceInst.createTable(tableDesign);
                return ToolResponse(`Table '${tableName}' created successfully. Table Id: ${tableId}`);
            }, workspaceId, tableName, columns_arr);
        } catch (err) {
            return logAndReturnError(err, "An error occurred while creating the table");
        }
    });

    // server.registerTool("create_aggregate_formula",
    // {
    //     description: "Create an aggregate formula in the specified table of the workspace",
    //     inputSchema: {
    //     workspace_id: z.string().describe("The ID of the workspace"),
    //     table_id: z.string().describe("The ID of the table"),
    //     expression: z.string().describe("The expression for the aggregate formula"),
    //     formula_name: z.string().describe("The name of the aggregate formula")
    //     }
    // },
    // async ({ workspace_id, table_id, expression, formula_name }) => {
    //     try {
    //     const analyticsClient = getAnalyticsClient();
    //     const view = analyticsClient.getViewInstance(config.ORGID || "", workspace_id, table_id);
    //     var configParam = {}
        
    //     // Since addAggregateFormula doesn't exist, we'll need to use a different approach
    //     // For now, we'll create a placeholder implementation
    //     // const formulaId = await view.addAggregateFormula(formula_name, expression, configParam);
        
    //     // Placeholder implementation
    //     const formulaId = "placeholder-formula-id";
        
    //     return {
    //         content: [{ 
    //         type: "text", 
    //         text: `Aggregate formula '${formula_name}' created successfully. Formula Id: ${formulaId}` 
    //         }]
    //     };
    //     } catch (error) {
    //     return {
    //         content: [{ 
    //         type: "text", 
    //         text: `An error occurred while creating the aggregate formula: ${error}` 
    //         }]
    //     };
    //     }
    // });

    server.registerTool("create_chart_report",
    {
    description: `
Create a chart report in the specified workspace for a table in Zoho Analytics.

Use Cases:
- Create a chart report in the specified workspace for a table in Zoho Analytics.
- Use this to generate visual representations of data using bar, line, pie, scatter, or bubble charts.

Important Notes:
- A chart is a report that visually represents data from a table or multiple tables.
- If y-axis operation is "actual", only "scatter" chart is allowed. For all other chart types, use "sum" for numeric columns and "count" for string columns in y-axis.
- Charts can include filters to narrow down the dataset.
- A chart can be created over columns from the same table or from other tables with which a relationship is defined.
- For x-axis operations for numeric columns, use "measure" or "dimension" instead of "actual", depending upon the type of the numeric column.
    `,
    inputSchema: {
      workspace_id: z.string().describe("ID of the workspace to create the chart in."),
      table_name: z.string().describe("The base table name for the chart."),
      chart_name: z.string().describe("Desired name for the chart report."),
      chart_details: z
        .object({
          chartType: z
            .enum(["bar", "line", "pie", "scatter", "bubble"])
            .describe("Type of chart."),
          x_axis: z
            .object({
              columnName: z.string().describe("Name of the column for the x-axis."),
              operation: z.string().describe("Operation to perform on the column."),
              tableName: z
                .string()
                .optional()
                .describe("If column belongs to another related table, specify the table name."),
            })
            .describe("X-axis column details."),
          y_axis: z
            .object({
              columnName: z.string().describe("Name of the column for the y-axis."),
              operation: z.string().describe("Operation to perform on the column."),
              tableName: z
                .string()
                .optional()
                .describe("If column belongs to another related table, specify the table name."),
            })
            .describe("Y-axis column details."),
        })
        .describe("Chart configuration details."),
      filters: z
        .array(
          z.object({
            tableName: z.string().describe("Table containing the column to filter."),
            columnName: z.string().describe("Column to filter."),
            operation: z
              .string()
              .describe(
                "Function applied to the column. Accepted functions differ by data type."
              ),
            filterType: z
              .string()
              .describe(
                "Type of filter. e.g. individualValues, range, ranking, dateRange, etc."
              ),
            values: z.array(z.string()).describe("Values to filter on."),
            exclude: z.boolean().describe("Whether to exclude or include the filtered values."),
          })
        )
        .optional()
        .describe("List of filters to apply on the chart."),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization ID to which the workspace belongs. Defaults to config value if not provided."
        ),
    },
  },
  async ({
    workspace_id,
    table_name,
    chart_name,
    chart_details,
    filters,
    orgId,
    }) => {
    
    try {
        if (!orgId) {
            orgId = config.ORGID || "";
        }
        if (!chart_details.chartType) {
            return ToolResponse("Chart type is required. Please provide 'chartType' in chart_details.");
        }
        const { chartType, x_axis, y_axis } = chart_details;
        if (!x_axis || !y_axis) {
            return ToolResponse("Both x_axis and y_axis must be provided in chart_details.");
        }
        if (!x_axis.columnName || !x_axis.operation) {
            return ToolResponse("x_axis must contain 'columnName' and 'operation'.");
        }
        if (!y_axis.columnName || !y_axis.operation) {
            return ToolResponse("y_axis must contain 'columnName' and 'operation'.");
        }
        if (["bar", "line", "pie", "bubble"].includes(chartType) && ["Measure", "sum", "average", "min", "max"].includes(x_axis.operation)) {
            return ToolResponse(`For chart type '${chartType}', x_axis operation cannot be '${x_axis.operation}'. Use 'dimension' instead.`);
        }
        if (["bar", "line", "pie", "bubble"].includes(chartType) && y_axis.operation === "actual") {
            return ToolResponse(`For chart type '${chartType}', y_axis operation cannot be 'actual'. Use 'sum' instead.`);
        }
        const axisColumns: any[] = [];
        for (const [axisType, axis] of [["xAxis", x_axis], ["yAxis", y_axis]] as const) {
            const axisConfig: Record<string, any> = {
                type: axisType,
                columnName: axis.columnName,
                operation: axis.operation,
            };
            if (axis.tableName) axisConfig.tableName = axis.tableName;
            axisColumns.push(axisConfig);
        }
        const conf: Record<string, any> = {
            baseTableName: table_name,
            title: chart_name,
            reportType: "chart",
            chartType,
            axisColumns,
        };
        if (filters) {
            if (!Array.isArray(filters)) {
                return ToolResponse("Filters must be provided as an array of objects.");
            }
            for (const f of filters) {
                if (!("columnName" in f && "operation" in f && "filterType" in f && "values" in f && "exclude" in f)) {
                    return ToolResponse("Each filter must contain 'columnName', 'operation', 'filterType', 'values', and 'exclude'.");
                }
            }
            conf.filters = filters;
        }
        return await retryWithFallback([orgId], workspace_id, "WORKSPACE", async (orgId, workspace) => {
            const ac = getAnalyticsClient();
            const workspaceInst = ac.getWorkspaceInstance(orgId || "", workspace);
            const reportId = await workspaceInst.createReport(conf);
            return ToolResponse(`Chart report created successfully. Report ID: ${reportId}`);
        }, workspace_id);
    } catch (error: any) {
        if (typeof error.message === "string" && error.message.includes("Invalid input") && error.message.includes("operation") && error.message.includes("actual")) {
            return logAndReturnError("Invalid operation 'actual' for numeric column. Use 'sum' or 'count' instead.", "Chart creation error");
        }
        return logAndReturnError(error, "An error occurred while creating the chart report");
    }
  }
    );

    server.registerTool("create_summary_report",
    {
        description: "Create a summary report in the specified workspace and table in Zoho Analytics.",
        inputSchema: {
            workspaceId: z.string().describe("ID of the workspace where the Summary report will be created"),
        tableName: z.string().describe("Base table name for the summary report"),
        reportName: z.string().describe("Name for the Summary report"),
        summaryDetails: z.object({
            group_by: z.array(z.object({
            columnName: z.string(),
            tableName: z.string()
            })).nonempty(),
            aggregate: z.array(z.object({
            columnName: z.string(),
            operation: z.string(), // could restrict to union type: "sum" | "average" | ...
            tableName: z.string()
            })).nonempty()
        }),
        filters: z.array(z.object({
            tableName: z.string().optional(),
            columnName: z.string(),
            operation: z.string(),
            filterType: z.string(),
            values: z.array(z.string()),
            exclude: z.boolean()
        })).optional(),
        orgId: z.string().optional()
        }
    },
    async ({ workspaceId, tableName, reportName, summaryDetails, filters, orgId }) => {
        try {
            if (!orgId) {
                orgId = config.ORGID || "";
            }
            if (!summaryDetails.group_by || !summaryDetails.aggregate) {
                return ToolResponse("Both 'group_by' and 'aggregate' must be provided in summary_details.");
            }
            const axisColumns: any[] = [];
            for (const gb of summaryDetails.group_by) {
                axisColumns.push({
                    type: "groupBy",
                    columnName: gb.columnName,
                    operation: "actual",
                    tableName: gb.tableName
                });
            }
            for (const ag of summaryDetails.aggregate) {
                if (ag.operation === "actual") {
                    return ToolResponse("Invalid operation 'actual' in aggregate. Use 'sum', 'count', etc.");
                }
                axisColumns.push({
                    type: "summarize",
                    columnName: ag.columnName,
                    operation: ag.operation,
                    tableName: ag.tableName
                });
            }
            const conf: any = {
                baseTableName: tableName,
                title: reportName,
                reportType: "summary",
                axisColumns
            };
            if (filters) {
                conf.filters = filters;
            }
            return await retryWithFallback([orgId], workspaceId, "WORKSPACE", async (orgId, workspace) => {
                const analyticsClient = getAnalyticsClient();
                const workspaceInst = analyticsClient.getWorkspaceInstance(orgId || "", workspace);
                const reportId = await workspaceInst.createReport(conf);
                return ToolResponse(`Summary report created successfully. Report ID: ${reportId}`);
            },workspaceId);
        } catch (err) {
            return logAndReturnError(err, "An error occurred while creating the summary report");
        }
    });

    server.registerTool("create_pivot_report",
    {
        description: `
    Create a pivot table report in the specified workspace and table in Zoho Analytics.

    Use this when you need multidimensional data summaries by defining rows, columns, and data fields.

    Important Notes:
    - All pivot details (row, column, data) are optional individually but at least one of them must be provided and valid.
    - Allowed operations:
        - String columns: actual, count, distinctCount
        - Number columns: measure, dimension, sum, average, min, max, count
        - Date columns: year, month, week, day
    - Data fields require aggregate operations like sum, count, etc.
    - Lookup fields from other tables can be used if lookup is already defined.
    - For row and column fields, prefer non-aggregate operations like actual, measure or dimension depending on the data type. 
    For data fields, prefer aggregate operations like sum, count, etc.
        `,
        inputSchema: {
        workspaceId: z.string().describe("ID of the workspace to create the report in."),
        tableName: z.string().describe("Base table name for the report."),
        reportName: z.string().describe("Desired name of the pivot report."),
        pivotDetails: z.object({
            row: z.array(z.object({
            columnName: z.string(),
            tableName: z.string(),
            operation: z.string()
            })).optional(),
            column: z.array(z.object({
            columnName: z.string(),
            tableName: z.string(),
            operation: z.string()
            })).optional(),
            data: z.array(z.object({
            columnName: z.string(),
            tableName: z.string(),
            operation: z.string()
            })).optional()
        }),
        filters: z.array(z.object({
            tableName: z.string().optional(),
            columnName: z.string(),
            operation: z.string(),
            filterType: z.string(),
            values: z.array(z.string()),
            exclude: z.boolean()
        })).optional(),
        orgId: z.string().optional()
        }
    },
    async ({ workspaceId, tableName, reportName, pivotDetails, filters, orgId }) => {
        try {
            if (!orgId) {
                orgId = config.ORGID || "";
            }
            if (!pivotDetails) {
                return ToolResponse("Pivot details must be provided.");
            }
            if (!pivotDetails.row && !pivotDetails.column && !pivotDetails.data) {
                return ToolResponse("At least one of 'row', 'column', or 'data' must be provided in pivotDetails.");
            }
            const axisColumns: any[] = [];
            const requiredKeys = ["columnName", "tableName", "operation"];
            for (const [axisType, axisKey] of [["row", "row"], ["column", "column"], ["data", "data"]] as const) {
                const axisList = (pivotDetails as any)[axisKey];
                if (axisList) {
                    if (!Array.isArray(axisList) || axisList.length === 0) {
                        return ToolResponse(`${axisKey} must be a non-empty list of dictionaries with 'columnName', 'tableName', and 'operation'.`);
                    }
                    for (const entry of axisList) {
                        if (!requiredKeys.every(k => k in entry)) {
                            return ToolResponse(`Each entry in '${axisKey}' must contain 'columnName', 'tableName', and 'operation'.`);
                        }
                        const defaultOperation = (axisType === "row" || axisType === "column") ? "actual" : "count";
                        axisColumns.push({
                            type: axisType,
                            columnName: entry.columnName,
                            operation: entry.operation || defaultOperation,
                            tableName: entry.tableName
                        });
                    }
                }
            }
            const conf: any = {
                baseTableName: tableName,
                title: reportName,
                reportType: "pivot",
                axisColumns
            };
            if (filters) {
                if (!Array.isArray(filters)) {
                    return ToolResponse("Filters must be a list of dictionaries.");
                }
                for (const f of filters) {
                    if (!["columnName", "operation", "filterType", "values", "exclude"].every(k => k in f)) {
                        return ToolResponse("Each filter must contain 'columnName', 'operation', 'filterType', 'values', and 'exclude'.");
                    }
                }
                conf.filters = filters;
            }
            return await retryWithFallback([orgId], workspaceId, "WORKSPACE", async (orgId, workspace, bodyConf) => {
                const analyticsClient = getAnalyticsClient();
                const workspaceInst = analyticsClient.getWorkspaceInstance(orgId || "", workspace);
                const reportId = await workspaceInst.createReport(bodyConf);
                return ToolResponse(`Pivot report created successfully. Report ID: ${reportId}`);
            }, workspaceId, conf);
        } catch (err) {
            return logAndReturnError(err, "An error occurred while creating the pivot report");
        }
    });

    server.registerTool("create_query_table",
    {
        description: "Create a query table in the specified workspace with the given name and SQL query",
        inputSchema: {
        workspaceId: z.string().describe("The ID of the workspace in which to create the query table"),
        tableName: z.string().describe("The name of the query table to create"),
        query: z.string().describe("The SQL select query to create the query table"),
        orgId: z.string().optional().describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided.")
        }
    },
    async ({ workspaceId, tableName, query, orgId }) => {
        try {
            if (!orgId) {
                orgId = config.ORGID || "";
            }
            return await retryWithFallback([orgId], workspaceId, "WORKSPACE", async(orgId, workspace, table, sql) => {
                const analyticsClient = getAnalyticsClient();
                const workspaceInst = analyticsClient.getWorkspaceInstance(orgId, workspace);
                const configParam = {};
                const tableId = await workspaceInst.createQueryTable(sql, table, configParam);
                return ToolResponse(`Query table '${table}' created successfully. Table Id: ${tableId}`);
            }, workspaceId, tableName, query);            
        } catch (err) {
            return logAndReturnError(err, "An error occurred while creating the query table");
        }
    });

    server.registerTool("delete_view",
    {
      description: `
      <use_case>
        Delete a view (table, report, or dashboard) in the specified workspace.
      </use_case>

      <arguments>
        - workspace_id (string): The ID of the workspace containing the view.
        - view_id (string): The ID of the view to delete.
        - org_id (string | null | undefined): The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided.
      </arguments>
      `,
      inputSchema: {
        workspace_id: z.string(),
        view_id: z.string(),
        org_id: z.string().nullable().optional(),
      },
    },
    async ({ workspace_id, view_id, org_id }) => {
        try {
            if (!org_id){
                org_id = config.ORGID || "";
            }
            return await retryWithFallback([org_id], workspace_id, "WORKSPACE", async (orgId, workspace, view) => {
                const analyticsClient = getAnalyticsClient();
                const viewInstance = analyticsClient.getViewInstance(orgId || "", workspace, view);
                await viewInstance.delete();
                return ToolResponse(`View with ID ${view} deleted successfully from workspace ${workspace}.`);
            }, workspace_id, view_id);
        } catch (err) {
            return logAndReturnError(err, "An error occurred while deleting the view");
        }
    }
  );
}