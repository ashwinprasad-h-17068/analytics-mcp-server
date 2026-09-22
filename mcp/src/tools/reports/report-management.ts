import { z } from "zod";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";
import { validateChartCompatibility, type AxisColumnInput } from "./chart-validation";

// ---- Tool Registrations ----

defineTool({
  name: "createReport",
  description: `
    Create a report in the specified workspace in Zoho Analytics.
    Maps directly to the Zoho Analytics Create Report API.

    Supported report types (set via 'reportType'):
    1. "chart"   - Visual data representations using a wide variety of chart types.
                   Requires 'chartConfig'.
    2. "summary" - Grouped aggregate reports with group-by and aggregate logic.
                   Requires 'summaryConfig'.
    3. "pivot"   - Multidimensional data summaries with rows, columns, and data fields.
                   Requires 'pivotConfig'.

    Always provide exactly one config object matching the chosen 'reportType'.

    -- Chart Config (reportType: "chart") ------------------------------------------
    - chartType (str): The chart type. Examples: "bar", "horizontal bar", "stacked bar", "line",
      "area", "pie", "ring", "scatter", "bubble", "packed bubble", "funnel", "pyramid",
      "butterfly", "combo", "heat map", "tree map", "sunburst", "sankey", "word cloud",
      "race line", "race bar", "race bubble", "gantt", "histogram", "web",
      "map scatter", "map filled", "map bubble", "map pie", "geo heat map"
    - axisColumns (list[dict]): List of axis column definitions. Each entry has:
        - type (str): Axis shelf - one of "xAxis", "yAxis", "colorAxis", "sizeAxis", "textAxis"
        - columnName (str): Name of the column.
        - operation (str):
            String columns: actual, count, distinctCount
            Number columns: measure, dimension, sum, average, min, max, count, distinctCount
            Date columns:   year, month, week, day, fullDate, dateTime, range, monthYear, quarterYear, weekYear, count, distinctCount
        - tableName (optional str): If the column belongs to a related table, provide its name.
    - Notes:
        - "sizeAxis" is required for bubble and packed bubble charts.
        - Use "colorAxis" to add a color dimension/aggregate for chart coloring.
        - Columns in axisColumns can belong to multiple related tables (via lookup relationships).
        - The tool validates chart compatibility and returns a detailed error if the column/operation
          configuration is invalid for the specified chart type.
        - Validate filter values using the queryData tool before setting filters.

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
    - tableName (str, optional)
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
        chartType: z
          .string()
          .describe(
            'Chart type, e.g. "bar", "line", "pie", "scatter", "bubble", "stacked bar", "funnel", "heat map", "sankey", and many more.'
          ),
        axisColumns: z
          .array(
            z.object({
              type: z
                .enum(["xAxis", "yAxis", "colorAxis", "sizeAxis", "textAxis"])
                .describe('Axis shelf: "xAxis", "yAxis", "colorAxis", "sizeAxis", or "textAxis"'),
              columnName: z.string().describe("Name of the column"),
              operation: z
                .string()
                .describe(
                  "Operation for the column. String: actual/count/distinctCount. Number: measure/dimension/sum/average/min/max/count/distinctCount. Date: year/month/week/day/fullDate/dateTime/range/monthYear/quarterYear/weekYear/count/distinctCount"
                ),
              tableName: z
                .string()
                .optional()
                .describe("If the column belongs to a related table, provide its name"),
            })
          )
          .min(1)
          .describe("List of axis column definitions"),
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
  handler: async ({
    workspaceId,
    tableName,
    reportName,
    reportType,
    chartConfig,
    summaryConfig,
    pivotConfig,
    filters,
  }) => {
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
        const { chartType, axisColumns: inputAxisColumns } = chartConfig;

        if (!chartType) {
          return ToolResponse("Chart type is required. Please provide 'chartType' in chartConfig.");
        }
        if (!inputAxisColumns || inputAxisColumns.length === 0) {
          return ToolResponse("At least one axis column must be provided in chartConfig.axisColumns.");
        }

        // Validate each axis column has required fields
        for (let i = 0; i < inputAxisColumns.length; i++) {
          const col = inputAxisColumns[i];
          if (!col.columnName) {
            return ToolResponse(`axisColumns[${i}] is missing 'columnName'.`);
          }
          if (!col.operation) {
            return ToolResponse(`axisColumns[${i}] ('${col.columnName}') is missing 'operation'.`);
          }
          if (!col.type) {
            return ToolResponse(
              `axisColumns[${i}] ('${col.columnName}') is missing 'type'. Must be one of: xAxis, yAxis, colorAxis, sizeAxis, textAxis.`
            );
          }
        }

        // Run compatibility validation
        const validation = validateChartCompatibility(chartType, inputAxisColumns as AxisColumnInput[]);
        if (!validation.valid) {
          return ToolResponse(validation.error!);
        }

        // Build payload axisColumns
        for (const col of inputAxisColumns) {
          const entry: Record<string, any> = {
            type: col.type,
            columnName: col.columnName,
            operation: col.operation,
          };
          if (col.tableName) entry.tableName = col.tableName;
          axisColumns.push(entry);
        }

        conf.chartType = chartType;

        if (filters) {
          for (const f of filters) {
            if (
              !("columnName" in f && "operation" in f && "filterType" in f && "values" in f && "exclude" in f)
            ) {
              return ToolResponse(
                "Each filter must contain 'columnName', 'operation', 'filterType', 'values', and 'exclude'."
              );
            }
          }
        }
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
          return ToolResponse(
            "At least one of 'row', 'column', or 'data' must be provided in pivotConfig."
          );
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
              const defaultOperation =
                axisKey === "row" || axisKey === "column" ? "actual" : "count";
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
          const reportId = await (workspaceInst as any).createReport(conf);
          return ToolResponse(`${reportTypeLabel} report created successfully. Report ID: ${reportId}`);
        },
        workspaceId
      );
    } catch (error: any) {
      if ("errorMessage" in error && "errorCode" in error) {
        const { errorMessage, errorCode } = error as { errorMessage: string; errorCode: number };
        if (errorCode === 8166) {
          return ToolResponse(
            errorMessage +
              "\nSupported operations for columns of different types:\n" +
              "  String: actual, count, distinctCount\n" +
              "  Number: measure, dimension, sum, average, min, max, count, distinctCount\n" +
              "  Date:   year, month, week, fullDate, dateTime, range, monthYear, quarterYear, weekYear, count, distinctCount"
          );
        }
      }
      return logAndReturnError(error, "An error occurred while creating the report");
    }
  },
});

defineTool({
  name: "updateReport",
  description: `
    Update an existing report in the specified workspace in Zoho Analytics.
    Supports all report types: chart, pivot, and summary.

    IMPORTANT:
    - ALWAYS call the readReportMetadata tool first to retrieve the current configuration.
      The update is a FULL REPLACEMENT — the complete axis, filter, and user-filter configuration
      is replaced with whatever is sent. If you omit filters, existing filters are cleared.
    - baseTableName must NOT be provided for updates (it is inferred from the existing report).
    - title is optional in update. Omit it to keep the existing title.
    - reportType must always be supplied and must match the existing report type.

    -- Chart Update (reportType: "chart") ------------------------------------------
    - chartConfig is required. Contains:
        - chartType (str): The chart type. Examples: "bar", "horizontal bar", "stacked bar", "line",
          "area", "pie", "ring", "scatter", "bubble", "packed bubble", "funnel", "pyramid",
          "butterfly", "combo", "heat map", "tree map", "sunburst", "sankey", "word cloud",
          "race line", "race bar", "race bubble", "gantt", "histogram", "web",
          "map scatter", "map filled", "map bubble", "map pie", "geo heat map"
        - axisColumns (list[dict]): Each entry has:
            - type (str): "xAxis", "yAxis", "colorAxis", "sizeAxis", or "textAxis"
            - columnName (str)
            - operation (str):
                String: actual, count, distinctCount
                Number: measure, dimension, sum, average, min, max, count, distinctCount
                Date:   year, month, week, day, fullDate, dateTime, range, monthYear, quarterYear, weekYear, count, distinctCount
            - tableName (optional str): For columns from related tables.
    - The tool validates chart compatibility (axis columns vs. chart type).

    -- Summary Update (reportType: "summary") --------------------------------------
    - summaryConfig is required. Contains:
        - groupBy (list, min 1): Each entry - columnName, tableName, operation.
        - aggregate (list, min 1): Each entry - columnName, tableName, operation.
          Do NOT use "actual" in aggregate operations.

    -- Pivot Update (reportType: "pivot") ------------------------------------------
    - pivotConfig is required. At least one of row, column, or data must be provided. Contains:
        - row (optional list[dict]): Each dict - columnName, tableName, operation.
        - column (optional list[dict]): Same structure as row.
        - data (optional list[dict]): Same structure as row. Prefer aggregate operations.

    -- Filters (optional, all report types) ----------------------------------------
    Each filter:
    - tableName (str, optional)
    - columnName (str)
    - operation (str)
    - filterType (str): individualValues, range, ranking, rankingPct, dateRange, year, quarterYear,
      monthYear, weekYear, quarter, month, week, weekDay, day, hour, dateTime
    - values (list[str])
    - exclude (bool)
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the report"),
    reportId: z.string().describe("The ID of the report to update"),
    reportType: z
      .enum(["chart", "summary", "pivot"])
      .describe("Type of the report being updated — must match the existing report type"),
    title: z
      .string()
      .optional()
      .describe("Optional. New title for the report. Omit to keep the existing title."),
    chartConfig: z
      .object({
        chartType: z
          .string()
          .describe(
            'Chart type, e.g. "bar", "line", "pie", "scatter", "bubble", "stacked bar", "funnel", "heat map", "sankey", and many more.'
          ),
        axisColumns: z
          .array(
            z.object({
              type: z
                .enum(["xAxis", "yAxis", "colorAxis", "sizeAxis", "textAxis"])
                .describe('Axis shelf: "xAxis", "yAxis", "colorAxis", "sizeAxis", or "textAxis"'),
              columnName: z.string().describe("Name of the column"),
              operation: z
                .string()
                .describe(
                  "Operation for the column. String: actual/count/distinctCount. Number: measure/dimension/sum/average/min/max/count/distinctCount. Date: year/month/week/day/fullDate/dateTime/range/monthYear/quarterYear/weekYear/count/distinctCount"
                ),
              tableName: z
                .string()
                .optional()
                .describe("If the column belongs to a related table, provide its name"),
            })
          )
          .min(1)
          .describe("List of axis column definitions"),
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
      .describe("Optional filters. Omitting this clears existing filters."),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({
    workspaceId,
    reportId,
    reportType,
    title,
    chartConfig,
    summaryConfig,
    pivotConfig,
    filters,
    orgId,
  }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }

      const axisColumns: Record<string, any>[] = [];
      const conf: Record<string, any> = { reportType };

      if (title) {
        conf.title = title;
      }

      if (reportType === "chart") {
        if (!chartConfig) {
          return ToolResponse("chartConfig is required when reportType is 'chart'.");
        }
        const { chartType, axisColumns: inputAxisColumns } = chartConfig;

        if (!chartType) {
          return ToolResponse("Chart type is required. Please provide 'chartType' in chartConfig.");
        }
        if (!inputAxisColumns || inputAxisColumns.length === 0) {
          return ToolResponse("At least one axis column must be provided in chartConfig.axisColumns.");
        }

        // Validate each axis column has required fields
        for (let i = 0; i < inputAxisColumns.length; i++) {
          const col = inputAxisColumns[i];
          if (!col.columnName) {
            return ToolResponse(`axisColumns[${i}] is missing 'columnName'.`);
          }
          if (!col.operation) {
            return ToolResponse(`axisColumns[${i}] ('${col.columnName}') is missing 'operation'.`);
          }
          if (!col.type) {
            return ToolResponse(
              `axisColumns[${i}] ('${col.columnName}') is missing 'type'. Must be one of: xAxis, yAxis, colorAxis, sizeAxis, textAxis.`
            );
          }
        }

        // Run compatibility validation
        const validation = validateChartCompatibility(chartType, inputAxisColumns as AxisColumnInput[]);
        if (!validation.valid) {
          return ToolResponse(validation.error!);
        }

        // Build payload axisColumns
        for (const col of inputAxisColumns) {
          const entry: Record<string, any> = {
            type: col.type,
            columnName: col.columnName,
            operation: col.operation,
          };
          if (col.tableName) entry.tableName = col.tableName;
          axisColumns.push(entry);
        }

        conf.chartType = chartType;

        if (filters) {
          for (const f of filters) {
            if (
              !("columnName" in f && "operation" in f && "filterType" in f && "values" in f && "exclude" in f)
            ) {
              return ToolResponse(
                "Each filter must contain 'columnName', 'operation', 'filterType', 'values', and 'exclude'."
              );
            }
          }
        }
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
          return ToolResponse(
            "At least one of 'row', 'column', or 'data' must be provided in pivotConfig."
          );
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
              const defaultOperation =
                axisKey === "row" || axisKey === "column" ? "actual" : "count";
              axisColumns.push({
                type: axisKey,
                columnName: entry.columnName,
                operation: entry.operation || defaultOperation,
                tableName: entry.tableName,
              });
            }
          }
        }

        if (filters) {
          for (const f of filters) {
            if (
              !["columnName", "operation", "filterType", "values", "exclude"].every((k) => k in f)
            ) {
              return ToolResponse(
                "Each filter must contain 'columnName', 'operation', 'filterType', 'values', and 'exclude'."
              );
            }
          }
        }
      }

      conf.axisColumns = axisColumns;
      if (filters) {
        conf.filters = filters;
      }

      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace) => {
          const ac = getAnalyticsClient();
          const workspaceInst = ac.getWorkspaceInstance(org_id, workspace);
          await (workspaceInst as any).updateReport(reportId, conf);
          return ToolResponse(`${reportType.charAt(0).toUpperCase() + reportType.slice(1)} report '${reportId}' updated successfully.`);
        },
        workspaceId
      );
    } catch (error: any) {
      if ("errorMessage" in error && "errorCode" in error) {
        const { errorMessage, errorCode } = error as { errorMessage: string; errorCode: number };
        if (errorCode === 8166) {
          return ToolResponse(
            errorMessage +
              "\nSupported operations for columns of different types:\n" +
              "  String: actual, count, distinctCount\n" +
              "  Number: measure, dimension, sum, average, min, max, count, distinctCount\n" +
              "  Date:   year, month, week, fullDate, dateTime, range, monthYear, quarterYear, weekYear, count, distinctCount"
          );
        }
      }
      return logAndReturnError(error, "An error occurred while updating the report");
    }
  },
});
