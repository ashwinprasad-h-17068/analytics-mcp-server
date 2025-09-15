import { z } from "zod";
import type { ServerInstance } from "../common";
import {getAnalyticsClient, config } from '../utils/apiUtil';
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";
import dedent from "dedent";

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
            if (
                typeof err === "object" &&
                err !== null &&
                "errorCode" in err
            ) {
                const errorCode = (err as { errorCode: number }).errorCode;
                if (errorCode === 7101) {
                return ToolResponse("Workspace name is already taken. Provide an alternate name.");
                }
            }
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
    //     workspace_id: z.string(),
    //     table_id: z.string(),
    //     expression: z.string(),
    //     formula_name: z.string()
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
    description: dedent`
    Create a chart report in the specified workspace for a table in Zoho Analytics.

    1)Use Cases:
    - Create a chart report in the specified workspace for a table in Zoho Analytics.
    - Use this to generate visual representations of data using bar, line, pie, scatter, or bubble charts.

    2)Important Notes:
    - A chart is a report that visually represents data from a table or multiple tables.
    - If y-axis operation is "actual", only "scatter" chart is allowed. For all other chart types, use "sum" for numeric columns and "count" for string columns in y-axis.
    - Charts can include filters to narrow down the dataset.
    - A chart can be created over columns from the same table or from other tables with which a relationship is defined.
    - For x-axis operations for numeric columns, use "measure" or "dimension" instead of "actual", depending upon the type of the numeric column.
    
    3)Arguments:
    - workspace_id (str): ID of the workspace to create the chart in.
    - table_name (str): The base table name for the chart.
    - chart_name (str): Desired name for the chart report.
    - chart_details (dict): Details of the chart including:
        - chartType (str): One of ["bar", "line", "pie", "scatter", "bubble"]
        - x_axis (dict):
            - columnName (str)
            - operation (str): (strings) actual, count, distinctCount | (numbers) sum, average, min, max, measure, dimension, count, distinctCount  | (dates) year, month, week, fullDate, dateTime, range, count, distinctCount. 
            - tableName (optional [str]): If the column belongs to another table with which a relationship is defined with base table, provide the tableName.
        - y_axis (dict): Same structure as x_axis
    - filters (list[dict] | None): Optional. Filter definitions per <filters_args>.
    - org_id (str | None): The ID of the organization to which the workspace belongs to. If not provided, it defaults to the organization ID from the configuration.
    
        3.1)Filter Arguments:
        - tableName (str): The name of the table containing the column to filter.
        - columnName (str): The name of the column to filter.
        - operation (str): Specifies the function applied to the specified column used in the filter. The accepted functions differ based on the data type of the column.
            Date: year, quarterYear, monthYear, weekYear, fullDate, dateTime, range, quarter, month, week, weekDay, day, hour, count, distinctCount
            String: actual, count, distinctCount
            Number: measure, dimension, sum, average, min, max, count, distinctCount
        - filterType (str): The type of filter to apply. Accepted values: individualValues, range, ranking, rankingPct, dateRange, year, quarterYear, monthYear, weekYear, quarter, month, week, weekDay, day, hour, dateTime
        - values (list): The values to filter on.
            Example:
            - For individualValues: "value1", "value2"
            - For range: "10 to 20", "50 and above"
            - For ranking: "top 10", "bottom 5"
        - exclude (bool): Whether to exclude or include the filtered values. Default is False.

    4)Returns:
    - str: Chart creation status or error message.
    `,
    inputSchema: {
      workspace_id: z.string(),
      table_name: z.string(),
      chart_name: z.string(),
      chart_details: z
        .object({
          chartType: z
            .enum(["bar", "line", "pie", "scatter", "bubble"]),
          x_axis: z
            .object({
              columnName: z.string(),
              operation: z.string(),
              tableName: z
                .string()
                .optional()
            }),
          y_axis: z
            .object({
              columnName: z.string(),
              operation: z.string(),
              tableName: z
                .string()
                .optional(),
            }),
        }),
      filters: z
        .array(
          z.object({
            tableName: z.string(),
            columnName: z.string(),
            operation: z
              .string(),
            filterType: z
              .string(),
            values: z.array(z.string()),
            exclude: z.boolean(),
          })
        )
        .optional(),
      orgId: z
        .string()
        .optional(),
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
        description: dedent`
        1. use_case:
        - Create a summary report in the specified workspace and table in Zoho Analytics.
        - Use this to generate grouped aggregate reports, ideal for quick summaries with group-by and aggregate logic.
        - Creates a summary table that groups data by specified columns and applies aggregate functions.
        
        2. important_notes:
        - Do NOT use "actual" operation for numeric columns in aggregate. Use "sum" instead.
        - You can use lookup columns from other tables if relationships are already defined.

        3. arguments:
        - workspace_id (str): The ID of the workspace to create the Summary report in.
        - table_name (str): The name of the base table for the summary report.
        - report_name (str): The name for the Summary to be created.
        - summary_details (dict): Contains:
            - group_by (list[dict]): Each dict must have:
                - columnName (str)
                - tableName (str)
            - aggregate (list[dict]): Each dict must have:
                - columnName (str)
                - operation (str): sum, average, count, min, max, etc.
                - tableName (str): Need to be provided if the column belongs to another table with which a lookup is defined.
        - filters (list[dict] | None): Optional filters. See <filters_args> in create_chart tool.
        - org_id (str | None): The ID of the organization to which the workspace belongs to. If not provided, it defaults to the organization ID from the configuration.
        
            3.1. filter_args:
            - tableName (str): The name of the table containing the column to filter.
            - columnName (str): The name of the column to filter.
            - operation (str): Specifies the function applied to the specified column used in the filter. The accepted functions differ based on the data type of the column.
                Date: actual, seasonal, relative
                String: actual, count, distinctCount
                Number: measure, dimension, sum, average, min, max, count, distinctCount
            - filterType (str): The type of filter to apply. Accepted values: individualValues, range, ranking, rankingPct, dateRange, year, quarterYear, monthYear, weekYear, quarter, month, week, weekDay, day, hour, dateTime
            - values (list): The values to filter on.
                Example:
                - For individualValues: "value1", "value2"
                - For range: "10 to 20", "50 and above"
                - For ranking: "top 10", "bottom 5"
            - exclude (bool): Whether to exclude or include the filtered values. Default is False.
        
        4.returns:
        - str: Chart creation status or error message.
        `,
        inputSchema: {
            workspaceId: z.string(),
        tableName: z.string(),
        reportName: z.string(),
        summaryDetails: z.object({
            group_by: z.array(z.object({
            columnName: z.string(),
            tableName: z.string()
            })).nonempty(),
            aggregate: z.array(z.object({
                columnName: z.string(),
                operation: z.string(),
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
        workspaceId: z.string(),
        tableName: z.string(),
        reportName: z.string(),
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