import { z } from "zod";
import { defineTool } from "../tool-registry";
import { getAnalyticsClient, config } from "../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";

// ---- Tool Registrations ----

defineTool({
  name: "createWorkspace",
  description: "Create a new workspace in Zoho Analytics with the given name",
  args: {
    workspaceName: z.string().describe("Name of the workspace to create"),
  },
  handler: async ({ workspaceName }) => {
    try {
      const ac = getAnalyticsClient();
      const org = ac.getOrgInstance(config.ORGID || "");
      const workspace_id = await org.createWorkspace(workspaceName, {});
      return ToolResponse(`Workspace '${workspaceName}' created successfully. Workspace Id: ${workspace_id}`);
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "errorCode" in err &&
        (err as { errorCode: number }).errorCode === 7101
      ) {
        return ToolResponse("Workspace name is already taken. Provide an alternate name.");
      }
      return logAndReturnError(err, "An error occurred while creating the workspace");
    }
  },
});

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

defineTool({
  name: "createReport",
  description: `
    Create a report in the specified workspace in Zoho Analytics.
    Maps directly to the Zoho Analytics Create Report API (POST /workspaces/<id>/reports).

    Supported report types (set via 'reportType'):
    1. "chart"   - Visual data representations (bar, line, pie, scatter, bubble).
                   Requires 'chartConfig'.
    2. "summary" - Grouped aggregate reports with group-by and aggregate logic.
                   Requires 'summaryConfig'.
    3. "pivot"   - Multidimensional data summaries with rows, columns, and data fields.
                   Requires 'pivotConfig'.

    Always provide exactly one config object matching the chosen 'reportType'.

    -- Chart Config (reportType: "chart") ------------------------------------------
    - chartType: One of ["bar", "line", "pie", "scatter", "bubble"]
    - xAxis / yAxis:
        - columnName (str)
        - operation (str):
            String: actual, count, distinctCount
            Number: sum, average, min, max, measure, dimension, count, distinctCount
            Date:   year, month, week, fullDate, dateTime, range, count, distinctCount
        - tableName (optional str): Column's table when from a related table.
    - Rules:
        - If yAxis operation is "actual", only "scatter" is allowed.
        - For bar/line/pie/bubble: yAxis operation must not be "actual"; use "sum"/"count".
        - For numeric xAxis in bar/line/pie/bubble: use "dimension", not aggregate operations.

    -- Summary Config (reportType: "summary") --------------------------------------
    - groupBy (list, min 1): Each entry - columnName, tableName, operation.
        Date:   year, quarterYear, monthYear, weekYear, fullDate, dateTime, range, quarter, month, week, weekDay, day, hour, count, distinctCount
        String: actual, count, distinctCount
        Number: measure, dimension, sum, average, min, max, count, distinctCount
    - aggregate (list, min 1): Each entry - columnName, tableName, operation (e.g. sum, count, average, min, max).
        Do NOT use "actual" in aggregate operations.

    -- Pivot Config (reportType: "pivot") ------------------------------------------
    - row / column / data (all optional, but at least one required): Each entry - columnName, tableName, operation.
        String: actual, count, distinctCount
        Number: measure, dimension, sum, average, min, max, count
        Date:   year, month, week, day
    - For row/column: prefer non-aggregate operations (actual, measure, dimension).
    - For data: prefer aggregate operations (sum, count, etc.).

    -- Filters (optional, all report types) ----------------------------------------
    Each filter:
    - tableName (str)
    - columnName (str)
    - operation (str)
    - filterType (str): individualValues, range, ranking, rankingPct, dateRange, year, quarterYear, monthYear, weekYear, quarter, month, week, weekDay, day, hour, dateTime
    - values (list[str])
    - exclude (bool)
  `,
  args: {
    workspaceId: z.string().describe("ID of the workspace to create the report in"),
    tableName: z.string().describe("Name of the base table for the report"),
    reportName: z.string().describe("Desired name for the report"),
    reportType: z.enum(["chart", "summary", "pivot"]).describe("Type of report to create"),
    chartConfig: z
      .object({
        chartType: z.enum(["bar", "line", "pie", "scatter", "bubble"]),
        xAxis: z.object({
          columnName: z.string(),
          operation: z.string(),
          tableName: z.string().optional(),
        }),
        yAxis: z.object({
          columnName: z.string(),
          operation: z.string(),
          tableName: z.string().optional(),
        }),
      })
      .optional()
      .describe("Required when reportType is 'chart'"),
    summaryConfig: z
      .object({
        groupBy: z
          .array(
            z.object({
              columnName: z.string(),
              tableName: z.string(),
              operation: z.string(),
            })
          )
          .min(1),
        aggregate: z
          .array(
            z.object({
              columnName: z.string(),
              tableName: z.string(),
              operation: z.string(),
            })
          )
          .min(1),
      })
      .optional()
      .describe("Required when reportType is 'summary'"),
    pivotConfig: z
      .object({
        row: z
          .array(
            z.object({
              columnName: z.string(),
              tableName: z.string(),
              operation: z.string(),
            })
          )
          .optional(),
        column: z
          .array(
            z.object({
              columnName: z.string(),
              tableName: z.string(),
              operation: z.string(),
            })
          )
          .optional(),
        data: z
          .array(
            z.object({
              columnName: z.string(),
              tableName: z.string(),
              operation: z.string(),
            })
          )
          .optional(),
      })
      .optional()
      .describe("Required when reportType is 'pivot'"),
    filters: z
      .array(
        z.object({
          tableName: z.string().optional(),
          columnName: z.string(),
          operation: z.string(),
          filterType: z.string(),
          values: z.array(z.string()),
          exclude: z.boolean(),
        })
      )
      .optional()
      .describe("Optional filters to restrict the dataset"),
  },
  handler: async ({ workspaceId, tableName, reportName, reportType, chartConfig, summaryConfig, pivotConfig, filters }) => {
    try {
      const orgId = config.ORGID || "";
      const axisColumns: Record<string, any>[] = [];
      const conf: Record<string, any> = {
        baseTableName: tableName,
        title: reportName,
        reportType,
      };

      if (reportType === "chart") {
        if (!chartConfig) {
          return ToolResponse("chartConfig is required when reportType is 'chart'.");
        }
        const { chartType, xAxis, yAxis } = chartConfig;

        if (!xAxis.columnName || !xAxis.operation) {
          return ToolResponse("xAxis must contain 'columnName' and 'operation'.");
        }
        if (!yAxis.columnName || !yAxis.operation) {
          return ToolResponse("yAxis must contain 'columnName' and 'operation'.");
        }
        if (
          ["bar", "line", "pie", "bubble"].includes(chartType) &&
          ["Measure", "sum", "average", "min", "max"].includes(xAxis.operation)
        ) {
          return ToolResponse(
            `For chart type '${chartType}', xAxis operation cannot be '${xAxis.operation}'. Use 'dimension' instead.`
          );
        }
        if (["bar", "line", "pie", "bubble"].includes(chartType) && yAxis.operation === "actual") {
          return ToolResponse(
            `For chart type '${chartType}', yAxis operation cannot be 'actual'. Use 'sum' instead.`
          );
        }

        for (const [axisType, axis] of [
          ["xAxis", xAxis],
          ["yAxis", yAxis],
        ] as const) {
          const axisEntry: Record<string, any> = {
            type: axisType,
            columnName: axis.columnName,
            operation: axis.operation,
          };
          if (axis.tableName) axisEntry.tableName = axis.tableName;
          axisColumns.push(axisEntry);
        }

        conf.chartType = chartType;
      } else if (reportType === "summary") {
        if (!summaryConfig) {
          return ToolResponse("summaryConfig is required when reportType is 'summary'.");
        }
        const { groupBy, aggregate } = summaryConfig;

        for (const gb of groupBy) {
          axisColumns.push({
            type: "groupBy",
            columnName: gb.columnName,
            operation: gb.operation,
            tableName: gb.tableName,
          });
        }
        for (const ag of aggregate) {
          if (ag.operation === "actual") {
            return ToolResponse("Invalid operation 'actual' in aggregate. Use 'sum', 'count', etc.");
          }
          axisColumns.push({
            type: "summarize",
            columnName: ag.columnName,
            operation: ag.operation,
            tableName: ag.tableName,
          });
        }
      } else {
        // reportType === "pivot"
        if (!pivotConfig) {
          return ToolResponse("pivotConfig is required when reportType is 'pivot'.");
        }
        if (!pivotConfig.row && !pivotConfig.column && !pivotConfig.data) {
          return ToolResponse("At least one of 'row', 'column', or 'data' must be provided in pivotConfig.");
        }

        const requiredKeys = ["columnName", "tableName", "operation"];
        for (const axisKey of ["row", "column", "data"] as const) {
          const axisList = pivotConfig[axisKey];
          if (axisList) {
            if (!Array.isArray(axisList) || axisList.length === 0) {
              return ToolResponse(
                `'${axisKey}' must be a non-empty list with 'columnName', 'tableName', and 'operation'.`
              );
            }
            for (const entry of axisList) {
              if (!requiredKeys.every((k) => k in entry)) {
                return ToolResponse(
                  `Each entry in '${axisKey}' must contain 'columnName', 'tableName', and 'operation'.`
                );
              }
              const defaultOperation = axisKey === "row" || axisKey === "column" ? "actual" : "count";
              axisColumns.push({
                type: axisKey,
                columnName: entry.columnName,
                operation: entry.operation || defaultOperation,
                tableName: entry.tableName,
              });
            }
          }
        }
      }

      conf.axisColumns = axisColumns;
      if (filters) {
        conf.filters = filters;
      }

      const reportTypeLabel = reportType.charAt(0).toUpperCase() + reportType.slice(1);
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace) => {
          const analyticsClient = getAnalyticsClient();
          const workspaceInst = analyticsClient.getWorkspaceInstance(org_id, workspace);
          const reportId = await workspaceInst.createReport(conf);
          return ToolResponse(`${reportTypeLabel} report created successfully. Report ID: ${reportId}`);
        },
        workspaceId
      );
    } catch (error: any) {
      if (
        typeof error.message === "string" &&
        error.message.includes("Invalid input") &&
        error.message.includes("operation") &&
        error.message.includes("actual")
      ) {
        return logAndReturnError(
          "Invalid operation 'actual' for numeric column. Use 'sum' or 'count' instead.",
          "Report creation error"
        );
      }
      if ("errorMessage" in error && "errorCode" in error) {
        const { errorMessage, errorCode } = error as { errorMessage: string; errorCode: number };
        if (errorCode === 8166) {
          return ToolResponse(
            errorMessage +
              "\nSupported operations for columns of different types:\n" +
              "For string:- actual, count, distinctCount\n" +
              "For number:- sum, average, min, max, measure, dimension, count, distinctCount\n" +
              "For dates:- year, month, week, fullDate, dateTime, range, count, distinctCount"
          );
        }
      }
      return logAndReturnError(error, "An error occurred while creating the report");
    }
  },
});

defineTool({
  name: "createQueryTable",
  description: "Create a query table in the specified workspace with the given name and SQL query",
  args: {
    workspaceId: z.string().describe("The ID of the workspace in which to create the query table"),
    tableName: z.string().describe("The name of the query table to create"),
    query: z.string().describe("The SQL select query to create the query table"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableName, query, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, table, sql) => {
          const analyticsClient = getAnalyticsClient();
          const workspaceInst = analyticsClient.getWorkspaceInstance(org_id, workspace);
          const configParam = {};
          const tableId = await workspaceInst.createQueryTable(sql, table, configParam);
          return ToolResponse(`Query table '${table}' created successfully. Table Id: ${tableId}`);
        },
        workspaceId,
        tableName,
        query
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while creating the query table");
    }
  },
});

defineTool({
  name: "deleteView",
  description: `
    Delete a view (table, report, or dashboard) in the specified workspace.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the view to delete"),
    viewId: z.string().describe("The ID of the view to delete"),
    orgId: z
      .string()
      .nullable()
      .optional()
      .describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided."),
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
        async (org_id, workspace, view) => {
          const analyticsClient = getAnalyticsClient();
          const viewInstance = analyticsClient.getViewInstance(org_id || "", workspace, view);
          await viewInstance.delete();
          return ToolResponse(`View with ID ${view} deleted successfully from workspace ${workspace}.`);
        },
        workspaceId,
        viewId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while deleting the view");
    }
  },
});