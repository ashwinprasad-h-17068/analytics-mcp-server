import { z } from "zod";
import { defineTool } from "../tool-registry";
import { getAnalyticsClient, config } from "../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";
import { getChartTypeSuggestions } from "../utils/charts";

// ─────────────────────────────────────────────────────────────────────────────
// Chart Compatibility Validation Framework
// ─────────────────────────────────────────────────────────────────────────────

/** Compatibility categories as defined in chart compatibility rules */
type CompatClass = "D" | "A" | "M" | "G" | "unknown";

/**
 * Classifies a column's operation into a compatibility category.
 *
 * D (Dimension): discrete/categorical - string actual, date time-parts, numeric as dimension/range/count
 * A (Aggregate): aggregated value - sum/avg/min/max/count/distinctCount on numeric
 * M (Measure): numeric in measure mode - treated as a continuous numeric value
 * G (Geo): geographic column
 */
function classifyOperation(operation: string): CompatClass {
  switch (operation) {
    case "actual":
    case "dimension":
    case "year":
    case "month":
    case "week":
    case "day":
    case "hour":
    case "quarter":
    case "weekDay":
    case "fullDate":
    case "dateTime":
    case "range":
    case "monthYear":
    case "quarterYear":
    case "weekYear":
    case "seasonal":
    case "relative":
      return "D";

    case "sum":
    case "average":
    case "min":
    case "max":
    case "count":
    case "distinctCount":
      return "A";

    case "measure":
      return "M";

    case "geo":
      return "G";

    default:
      return "unknown";
  }
}

/** All supported chart type aliases mapped to their canonical compatibility key */
const CHART_TYPE_ALIASES: Record<string, string> = {
  "bar":                        "bar|horizontalBar",
  "horizontal bar":             "bar|horizontalBar",
  "stacked bar":                "stackedBar|horizontalStackedBar",
  "horizontal stacked bar":     "stackedBar|horizontalStackedBar",
  "line":                       "line|smoothLine|step|area|smoothArea",
  "smooth line":                "line|smoothLine|step|area|smoothArea",
  "step":                       "line|smoothLine|step|area|smoothArea",
  "area":                       "line|smoothLine|step|area|smoothArea",
  "smooth area":                "line|smoothLine|step|area|smoothArea",
  "stacked area":               "stackedArea|stackedSmoothArea",
  "stacked smooth area":        "stackedArea|stackedSmoothArea",
  "pie":                        "pie|ring|semiPie|semiRing",
  "ring":                       "pie|ring|semiPie|semiRing",
  "semi pie":                   "pie|ring|semiPie|semiRing",
  "semi ring":                  "pie|ring|semiPie|semiRing",
  "funnel":                     "funnel|pyramid",
  "pyramid":                    "funnel|pyramid",
  "butterfly":                  "butterfly",
  "histogram":                  "histogram",
  "scatter":                    "scatter",
  "bubble":                     "bubble|packedBubble",
  "packed bubble":              "bubble|packedBubble",
  "bubble pie":                 "bubblePie",
  "combo":                      "combo|comboBarWithSmoothLine",
  "combo bar with smooth line": "combo|comboBarWithSmoothLine",
  "combo bar smooth line":      "combo|comboBarWithSmoothLine",
  "web":                        "web|webWithFill|webWithoutFill",
  "web with fill":              "web|webWithFill|webWithoutFill",
  "web without fill":           "web|webWithFill|webWithoutFill",
  "heat map":                   "heatMap",
  "map scatter":                "mapScatter|mapFilled",
  "map filled":                 "mapScatter|mapFilled",
  "map bubble":                 "mapBubble",
  "map pie":                    "mapPie|mapBubblePie",
  "map bubble pie":             "mapPie|mapBubblePie",
  "geo heat map":               "geoHeatMap",
  "tree map":                   "treeMap",
  "sunburst":                   "sunburst",
  "sankey":                     "sankey",
  "word cloud":                 "wordCloud",
  "race line":                  "raceLine|raceBar",
  "race bar":                   "raceLine|raceBar",
  "race bubble":                "raceBubble",
  "gantt":                      "gantt",
  "table chart":                "tableChart",
  "map area":                   "mapScatter|mapFilled",
  "area with points":           "line|smoothLine|step|area|smoothArea",
};

function normalizeChartType(chartType: string): string {
  const lower = chartType.toLowerCase();
  return CHART_TYPE_ALIASES[lower] ?? lower;
}

/** Constraint token from compatibility rules, e.g. "D", "A", "D|A", "MultiA", "Opt" */
type ConstraintToken = string;

function satisfiesConstraint(classes: CompatClass[], constraint: ConstraintToken): boolean {
  const tokens = constraint.split("|");
  const isOpt = tokens.includes("Opt");
  const nonOptTokens = tokens.filter((t) => t !== "Opt");

  if (classes.length === 0) return isOpt;

  if (nonOptTokens.includes("MultiA")) {
    const aCount = classes.filter((c) => c === "A").length;
    if (aCount >= 2) return true;
  }

  const allowedClasses = nonOptTokens.filter((t) => t !== "MultiA") as CompatClass[];
  if (allowedClasses.length === 0) return isOpt;

  return classes.every((c) => allowedClasses.includes(c));
}

type ShelfName = "x" | "y" | "color" | "size" | "text" | "tooltip";

interface AxisColumnInput {
  type: string;
  columnName: string;
  operation: string;
  tableName?: string;
}

function axisTypeToShelf(axisType: string): ShelfName | null {
  switch (axisType) {
    case "xAxis":     return "x";
    case "yAxis":     return "y";
    case "colorAxis": return "color";
    case "sizeAxis":  return "size";
    case "textAxis":  return "text";
    default:          return null;
  }
}

// Compatibility rules per chart type
const CHART_COMPAT: Record<string, Array<Partial<Record<ShelfName, ConstraintToken>>>> = {
  "pie|ring|semiPie|semiRing": [
    { x: "D", y: "A" },
    { x: "D|A", y: "Opt" },
    { x: "Opt", y: "A|D" },
  ],
  "funnel|pyramid": [
    { x: "D", y: "A" },
    { x: "Opt", y: "A" },
  ],
  "bar|horizontalBar": [
    { x: "D", y: "A|MultiA", color: "D|A|M|Opt" },
    { x: "D|A", y: "Opt" },
    { x: "Opt", y: "D|A" },
    { x: "A", y: "Opt" },
  ],
  "stackedBar|horizontalStackedBar": [
    { x: "D", y: "A", color: "D|A|M" },
    { x: "Opt", y: "D|A", color: "D|A|M" },
    { x: "D|A", y: "Opt", color: "D|A|M" },
  ],
  "butterfly": [
    { x: "D", y: "A", color: "D" },
    { x: "D", y: "MultiA" },
  ],
  "histogram": [
    { x: "D", y: "A|Opt" },
    { x: "Opt", y: "A" },
    { x: "A|Opt", y: "D" },
    { x: "A", y: "Opt" },
  ],
  "line|smoothLine|step|area|smoothArea": [
    { x: "D", y: "A|D|Opt", color: "D|A|M|Opt" },
    { x: "Opt", y: "A|D" },
    { x: "A|D", y: "Opt" },
  ],
  "stackedArea|stackedSmoothArea": [
    { x: "D", y: "A", color: "D|A|M" },
    { x: "D", y: "MultiA" },
  ],
  "scatter": [
    { x: "D", y: "A|D" },
    { x: "A", y: "A|D" },
    { x: "D|A", y: "Opt" },
  ],
  "bubble|packedBubble": [
    { x: "D|A", y: "A|D", size: "A" },
    { x: "D|A", y: "Opt", size: "A", color: "A|D" },
    { x: "Opt", y: "D|A", size: "A", color: "A|D" },
  ],
  "bubblePie": [
    { x: "D", y: "A", size: "A", color: "D" },
    { x: "D", y: "MultiA", size: "A" },
  ],
  "combo|comboBarWithSmoothLine": [
    { x: "D", y: "MultiA" },
    { x: "D", y: "A", color: "D" },
  ],
  "web|webWithFill|webWithoutFill": [
    { x: "D", y: "A", color: "D|Opt" },
  ],
  "heatMap": [
    { x: "D", y: "D", color: "A", size: "Opt" },
  ],
  "mapScatter|mapFilled": [
    { x: "G", y: "A|D|M|Opt" },
  ],
  "mapBubble": [
    { x: "G", y: "A|D|M|Opt", size: "A" },
  ],
  "mapPie|mapBubblePie": [
    { x: "G", y: "A|MultiA", size: "A|Opt", color: "A|D|M|Opt" },
  ],
  "geoHeatMap": [
    { x: "G", y: "A|D|M|Opt" },
  ],
  "treeMap": [
    { x: "D", y: "A|Opt", color: "D|A|M|Opt", size: "A|Opt" },
    { x: "A", y: "D|Opt", color: "D|A|M|Opt", size: "A|Opt" },
    { x: "A|Opt", y: "D", color: "D|A|M|Opt", size: "A|Opt" },
    { x: "D|Opt", y: "A", color: "D|A|M|Opt", size: "A|Opt" },
    { x: "D|Opt", y: "MultiA", size: "A|Opt" },
  ],
  "sunburst": [
    { x: "D", y: "A|M", color: "D", text: "D|Opt", tooltip: "D|Opt" },
  ],
  "sankey": [
    { x: "D", y: "D", text: "A|M",     size: "A|Opt",  tooltip: "A|M|Opt" },
    { x: "D", y: "D", text: "A|M|Opt", size: "A",      tooltip: "A|M|Opt" },
    { x: "D", y: "D", text: "A|M|Opt", size: "A|Opt",  tooltip: "A|M" },
  ],
  "wordCloud": [
    { x: "D",   y: "A|D", color: "A|D|M|Opt", size: "A" },
    { x: "A",   y: "A|D", color: "A|D|M|Opt", size: "A" },
    { x: "D",   y: "Opt", color: "A",          size: "A" },
    { x: "A",   y: "Opt", color: "D",          size: "A" },
    { x: "Opt", y: "D",   color: "A",          size: "A" },
    { x: "Opt", y: "A",   color: "D",          size: "A" },
  ],
  "raceLine|raceBar": [
    { x: "D", y: "A|M", color: "D" },
  ],
  "raceBubble": [
    { x: "A", y: "A", color: "D", size: "A", tooltip: "D" },
  ],
  "gantt": [
    { x: "D", y: "D" },
  ],
};

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates whether the provided axisColumns are compatible with the given chartType.
 * Returns { valid: true } on success, or { valid: false, error: <detailed message> } on failure.
 */
function validateChartCompatibility(
  chartType: string,
  axisColumns: AxisColumnInput[]
): ValidationResult {
  const normalizedKey = normalizeChartType(chartType);
  const cases = CHART_COMPAT[normalizedKey];

  if (!cases) {
    const suggestions = getChartTypeSuggestions(chartType, CHART_TYPE_ALIASES, 5);
    return {
      valid: false,
      error: suggestions.length
        ? `Given chart type was not found. Did you mean any of the following charts:\n${suggestions
            .map((s) => `- ${s}`)
            .join("\n")}`
        : "Chart type not found.",
    };
  }

  const shelves: Partial<Record<ShelfName, CompatClass[]>> = {};
  for (const col of axisColumns) {
    const shelf = axisTypeToShelf(col.type);
    if (!shelf) continue;
    const cls = classifyOperation(col.operation);
    if (!shelves[shelf]) shelves[shelf] = [];
    shelves[shelf]!.push(cls);
  }

  const allShelves = new Set<ShelfName>();
  for (const caseObj of cases) {
    for (const shelf of Object.keys(caseObj) as ShelfName[]) {
      allShelves.add(shelf);
    }
  }

  for (const caseObj of cases) {
    let caseMatches = true;
    for (const shelf of allShelves) {
      const constraint = caseObj[shelf] ?? "Opt";
      const classes = shelves[shelf] ?? [];
      if (!satisfiesConstraint(classes, constraint)) {
        caseMatches = false;
        break;
      }
    }
    if (caseMatches) return { valid: true };
  }

  const legend: Record<CompatClass, string> = {
    D:       "Dimension (discrete: string 'actual', date time-parts like year/month/week, numeric 'dimension')",
    A:       "Aggregate (sum/average/min/max/count/distinctCount)",
    M:       "Measure (numeric 'measure' - continuous numeric value)",
    G:       "Geo (geographic column)",
    unknown: "Unknown (unrecognized operation)",
  };

  const resolvedLines: string[] = [];
  for (const shelf of allShelves) {
    const cols = shelves[shelf] ?? [];
    if (cols.length === 0) {
      resolvedLines.push(`  - ${shelf}Axis: (empty)`);
    } else {
      const details = cols.map((cls, i) => {
        const op = axisColumns.filter((c) => axisTypeToShelf(c.type) === shelf)[i]?.operation ?? "?";
        return `${cls} [op: "${op}"]`;
      });
      resolvedLines.push(`  - ${shelf}Axis: [${details.join(", ")}]`);
    }
  }

  const caseLines = cases.map((caseObj, i) => {
    const parts = (Object.keys(caseObj) as ShelfName[]).map((s) => `${s}=${caseObj[s]}`);
    const failedShelves: string[] = [];
    for (const shelf of allShelves) {
      const constraint = caseObj[shelf] ?? "Opt";
      const classes = shelves[shelf] ?? [];
      if (!satisfiesConstraint(classes, constraint)) {
        const actual = classes.length === 0 ? "(empty)" : `[${classes.join(", ")}]`;
        failedShelves.push(`${shelf}Axis must be "${constraint}" but got ${actual}`);
      }
    }
    return `  Case ${i + 1}: { ${parts.join(", ")} } - FAILED: ${failedShelves.join("; ")}`;
  });

  const error = [
    `Chart compatibility validation failed for chart type "${chartType}".`,
    "",
    "Resolved axis classifications:",
    ...resolvedLines,
    "",
    "None of the valid configurations matched:",
    ...caseLines,
    "",
    "Legend:",
    `  D = ${legend.D}`,
    `  A = ${legend.A}`,
    `  M = ${legend.M}`,
    `  G = ${legend.G}`,
    "  MultiA = Two or more Aggregate columns on the same axis",
    "  Opt = Optional (may be empty)",
    "",
    "Action: Review your axisColumns and adjust the column types and/or operations so that",
    "at least one of the valid cases above is satisfied.",
  ].join("\n").trim();

  return { valid: false, error };
}

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
        const validation = validateChartCompatibility(chartType, inputAxisColumns);
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
  name: "editQueryTable",
  description: `
    Edit the SQL query of an existing query table in the specified workspace.

    Use Case:
    - Use this when you need to update or modify the SQL query that defines a query table.

    Important Notes:
    - Only the SQL query can be modified via this tool (CONFIG: sqlQuery).
    - The viewId must be the ID of the query table view (not a regular table or report).

    Returns:
    - A success message if the query table was updated successfully.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the query table"),
    viewId: z.string().describe("The ID of the query table to edit"),
    sqlQuery: z.string().describe("The new SQL select query to set for the query table"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, viewId, sqlQuery, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, view, sql) => {
          const analyticsClient = getAnalyticsClient();
          const workspaceInst = analyticsClient.getWorkspaceInstance(org_id, workspace);
          await workspaceInst.editQueryTable(view, sql);
          return ToolResponse(`Query table '${view}' updated successfully.`);
        },
        workspaceId,
        viewId,
        sqlQuery
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while editing the query table");
    }
  },
});

defineTool({
  name: "createLookup",
  description: `
    Creates a lookup relationship between two columns across two tables. A lookup is a relationship between two tables that connects a column in one table to a matching column in another table. A lookup tells the system that these two columns are related, allowing you to combine data from both tables in reports/dashboards/multi-table aggregate formulas.

    The direction of the relationship flows from source → target.
    For ONE_TO_MANY: source is the "one" (parent) side, target is the "many" (child) side.
    For ONE_TO_ONE and MANY_TO_MANY: source/target order is arbitrary but must be consistent.
    MANY_TO_ONE is not supported directly - swap the source and target and use ONE_TO_MANY instead.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing both tables"),
    sourceTableId: z.string().describe("ID of the source (typically parent/one-side) table"),
    sourceColumnId: z.string().describe("ID of the column in the source table to link from"),
    targetTableId: z.string().describe("ID of the target (typically child/many-side) table"),
    targetColumnId: z.string().describe("ID of the column in the target table to link to"),
    relationshipType: z
      .enum(["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY", "MANY_TO_ONE"])
      .describe(
        "Nature of the relationship. MANY_TO_ONE will be automatically converted to ONE_TO_MANY by swapping source and target."
      ),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({
    workspaceId,
    sourceTableId,
    sourceColumnId,
    targetTableId,
    targetColumnId,
    relationshipType,
    orgId,
  }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }

      // MANY_TO_ONE → swap source/target and use ONE_TO_MANY
      let effectiveRelationType = relationshipType;
      let effectiveSourceTableId = sourceTableId;
      let effectiveSourceColumnId = sourceColumnId;
      let effectiveTargetTableId = targetTableId;
      let effectiveTargetColumnId = targetColumnId;

      if (relationshipType === "MANY_TO_ONE") {
        effectiveRelationType = "ONE_TO_MANY";
        effectiveSourceTableId = targetTableId;
        effectiveSourceColumnId = targetColumnId;
        effectiveTargetTableId = sourceTableId;
        effectiveTargetColumnId = sourceColumnId;
      }

      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, srcTable, srcCol, tgtTable, tgtCol, relType) => {
          const ac = getAnalyticsClient();
          const viewInstance = ac.getViewInstance(org_id || "", workspace, srcTable);
          const references = [
            {
              viewId: tgtTable,
              columnId: tgtCol,
              relationType: relType,
            },
          ];
          await (viewInstance as any).addLookupV2(srcCol, references, {});
          return ToolResponse(
            `Lookup relationship created successfully. Source table: ${srcTable}, Source column: ${srcCol} → Target table: ${tgtTable}, Target column: ${tgtCol}, Relationship type: ${relType}`
          );
        },
        workspaceId,
        effectiveSourceTableId,
        effectiveSourceColumnId,
        effectiveTargetTableId,
        effectiveTargetColumnId,
        effectiveRelationType
      );
    } catch (err: any) {
      const errorCode = err?.errorCode;
      const errorMessage = err?.errorMessage;
      if (errorCode !== undefined) {
        return ToolResponse(`Error [${errorCode}]: ${errorMessage || "An unknown error occurred while creating the lookup"}`);
      }
      return logAndReturnError(err, "An error occurred while creating the lookup");
    }
  },
});

defineTool({
  name: "deleteLookup",
  description: "Remove a lookup relationship for a specified column in a table (view).",
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the table"),
    viewId: z.string().describe("The ID of the view (table) from which to remove the lookup"),
    columnId: z.string().describe("The ID of the column whose lookup relationship should be removed"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, viewId, columnId, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, view, col) => {
          const ac = getAnalyticsClient();
          const viewInstance = ac.getViewInstance(org_id || "", workspace, view);
          await (viewInstance as any).removeLookup(col, {});
          return ToolResponse(`Lookup relationship for column ${col} in view ${view} removed successfully.`);
        },
        workspaceId,
        viewId,
        columnId
      );
    } catch (err: any) {
      const errorCode = err?.errorCode;
      const errorMessage = err?.errorMessage;
      if (errorCode !== undefined) {
        return ToolResponse(`Error [${errorCode}]: ${errorMessage || "An unknown error occurred while removing the lookup"}`);
      }
      return logAndReturnError(err, "An error occurred while removing the lookup");
    }
  },
});

defineTool({
  name: "addAggregateFormula",
  description: `
    1. Use Case:
    - Create an aggregate formula in the specified table of a workspace in Zoho Analytics.
    - Use this when the user wants to define a reusable aggregate formula expression on a table.

    2. Important Notes:
    - Aggregate Formulas are select query expressions that return a single aggregate value as output.
    - The expression should always return a valid aggregate value.
    - Any column or table names used in the expression should be enclosed in double quotes. Literal values should be enclosed in single quotes.
    - While the expression can contain complex nested functions, it should always return a single aggregate value.
    - Assume the expression is MySQL-compatible.
    - Note that the tool also supports multi-table aggregate formulas, where the expression can reference columns from related tables (lookups should exist between such tables). In such cases, the expression should use the fully qualified column names (e.g., "TableName"."ColumnName") to avoid ambiguity.
    - Multi-table aggregate formulas should be created with the child table as the base table.
    - Enclose table and column names with double quotes whereas literal values with single quotes in the expression.

    3. Arguments:
    - workspaceId (str): The ID of the workspace.
    - tableId (str): The ID of the table (view) in which to create the aggregate formula.
    - formulaName (str): The name of the aggregate formula.
    - expression (str): The SQL aggregate expression.
        For example: SUM("Revenue") or AVG("Salary") or running_sum(sum("Sales"."Sales"))
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - str: Success message with the created formula ID, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    tableId: z.string().describe("The ID of the table (view) in which to create the aggregate formula"),
    formulaName: z.string().describe("The name of the aggregate formula to create"),
    expression: z
      .string()
      .describe('The SQL aggregate expression, e.g. SUM("Revenue") or running_sum(sum("Sales"."Sales"))'),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableId, formulaName, expression, orgId }) => {
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
          const viewInst = ac.getViewInstance(org_id, workspace, tableId);
          const formulaId = await (viewInst as any).addAggregateFormula(formulaName, expression);
          return ToolResponse(`Aggregate formula '${formulaName}' created successfully. Formula ID: ${formulaId}`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while creating the aggregate formula");
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom Formula Column Tools
// ─────────────────────────────────────────────────────────────────────────────

defineTool({
  name: "listCustomFormulaColumns",
  description: `
    Use Case:
    1) Fetches the list of custom formula columns defined on a specific table in Zoho Analytics.
    2) Use this to discover existing formula columns and their expressions before creating new ones or referencing them in reports.

    What are Custom Formula Columns?
    - Also referred to as formula columns or custom formula columns.
    - Unlike aggregate formulas (which return a single aggregated value), a custom formula column is a derived field defined by a SQL SELECT clause expression.
      It adds a new computed column to the table that is computed row-by-row.

    Important Notes:
    1) Formula columns are always scoped to a specific table (viewId). A tableId is always required.
    2) If formulaNameContainsStr is provided, only formulas whose names contain that string (case-insensitive) are returned.

    Returns:
    A JSON array of custom formula column objects. Each object contains:
    - formulaId: The unique identifier of the formula column.
    - formulaName: The name of the formula column.
    - expression: The SQL SELECT clause expression of the formula column.
    - description: A description of the formula column (if available).
    - tableName: The name of the table the formula column belongs to.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    tableId: z.string().describe("The ID of the table (view) whose formula columns should be listed"),
    formulaNameContainsStr: z
      .string()
      .optional()
      .describe(
        "Optional. If provided, filters and returns only those formula columns whose names contain this string (case-insensitive)."
      ),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableId, formulaNameContainsStr, orgId }) => {
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
          const viewInst = ac.getViewInstance(org_id, workspace, tableId);
          let formulas: any[] = await (viewInst as any).getFormulaColumns();

          if (!formulas || formulas.length === 0) {
            return ToolResponse("No custom formula columns found.");
          }

          // Apply name filter if provided
          if (formulaNameContainsStr && formulaNameContainsStr.trim() !== "") {
            const filterStr = formulaNameContainsStr.toLowerCase();
            formulas = formulas.filter(
              (f: any) => f.formulaName && f.formulaName.toLowerCase().includes(filterStr)
            );
            if (formulas.length === 0) {
              return ToolResponse(`No custom formula columns found matching '${formulaNameContainsStr}'.`);
            }
          }

          // Return only the relevant fields
          const result = formulas.map((f: any) => ({
            formulaId: f.formulaId,
            formulaName: f.formulaName,
            expression: f.expression,
            description: f.description ?? "",
            tableName: f.tableName,
          }));

          return ToolResponse(JSON.stringify(result));
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching custom formula columns");
    }
  },
});

defineTool({
  name: "addCustomFormulaColumn",
  description: `
    1. Use Case:
    - Create a custom formula column (derived field) in the specified table of a workspace in Zoho Analytics.
    - Use this when the user wants to add a new computed column to a table using a SQL SELECT clause expression.

    2. What are Custom Formula Columns?
    - Also referred to as formula columns or custom formula columns.
    - Unlike aggregate formulas (which return a single aggregated value), a custom formula column is defined by a SQL SELECT clause expression and represents a row-level derived field.
    - The expression should return a scalar value per row (not an aggregated value).
    - Any column or table names used in the expression should be enclosed in double quotes. Literal values should be enclosed in single quotes.
    - Assume the expression is MySQL-compatible.

    3. Arguments:
    - workspaceId (str): The ID of the workspace.
    - tableId (str): The ID of the table (view) in which to create the formula column.
    - formulaName (str): The name of the formula column to create.
    - expression (str): The SQL SELECT clause expression, e.g. "Price" * "Quantity" or IF("Status" = 'Active', 1, 0)
    - description (str | None): Optional description of the formula column.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - str: Success message with the created formula column ID, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    tableId: z.string().describe("The ID of the table (view) in which to create the formula column"),
    formulaName: z.string().describe("The name of the formula column to create"),
    expression: z
      .string()
      .describe('The SQL SELECT clause expression for the derived field, e.g. "Price" * "Quantity" or IF("Status" = \'Active\', 1, 0)'),
    description: z
      .string()
      .optional()
      .describe("Optional description of the formula column"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableId, formulaName, expression, description, orgId }) => {
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
          const viewInst = ac.getViewInstance(org_id, workspace, tableId);
          const sdkConfig: Record<string, string> = {};
          if (description) {
            sdkConfig.description = description;
          }
          const formulaId = await (viewInst as any).addFormulaColumn(formulaName, expression, sdkConfig);
          return ToolResponse(`Custom formula column '${formulaName}' created successfully. Formula ID: ${formulaId}`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while creating the custom formula column");
    }
  },
});

defineTool({
  name: "editCustomFormulaColumn",
  description: `
    1. Use Case:
    - Edit an existing custom formula column in the specified table of a workspace in Zoho Analytics.
    - Use this to update the expression or description of an existing formula column.

    2. Important Notes:
    - Use listCustomFormulaColumns to find the formulaId of the formula column you want to edit.
    - The expression should be a SQL SELECT clause expression (row-level derived field), not an aggregate expression.
    - Any column or table names in the expression should be enclosed in double quotes. Literal values in single quotes.
    - Assume the expression is MySQL-compatible.

    3. Arguments:
    - workspaceId (str): The ID of the workspace.
    - tableId (str): The ID of the table (view) that owns the formula column.
    - formulaId (str): The ID of the formula column to edit.
    - expression (str): The new SQL SELECT clause expression.
    - description (str | None): Optional. New description for the formula column.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - str: Success message, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    tableId: z.string().describe("The ID of the table (view) that owns the formula column"),
    formulaId: z.string().describe("The ID of the formula column to edit"),
    expression: z
      .string()
      .describe('The new SQL SELECT clause expression, e.g. "Price" * "Quantity" or IFNULL("Revenue", 0)'),
    description: z
      .string()
      .optional()
      .describe("Optional. New description for the formula column."),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableId, formulaId, expression, description, orgId }) => {
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
          const viewInst = ac.getViewInstance(org_id, workspace, tableId);
          const sdkConfig: Record<string, string> = {};
          if (description) {
            sdkConfig.description = description;
          }
          await (viewInst as any).editFormulaColumn(formulaId, expression, sdkConfig);
          return ToolResponse(`Custom formula column (ID: ${formulaId}) updated successfully.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while editing the custom formula column");
    }
  },
});

defineTool({
  name: "editAggregateFormula",
  description: `
    1. Use Case:
    - Edit an existing aggregate formula in Zoho Analytics.
    - Use this to update the aggregate expression or description.

    2. Important Notes:
    - Use listAggregateFormulas (or metadata tools) to find the formulaId of the aggregate formula you want to edit.
    - Aggregate formulas are typically used as measures (e.g. SUM/COUNT/AVG over columns, conditional aggregates, etc.).
    - Any column or table names in the expression should be enclosed in double quotes. Literal values in single quotes.
    - Assume the expression is MySQL-compatible.

    3. Arguments:
    - workspaceId (str): The ID of the workspace.
    - formulaId (str): The ID of the aggregate formula to edit.
    - expression (str): The new aggregate formula expression.
    - description (str | None): Optional. New description for the aggregate formula.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - str: Success message, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    formulaId: z.string().describe("The ID of the aggregate formula to edit"),
    expression: z
      .string()
      .describe('The new aggregate formula expression, e.g. SUM(IF("Status" = \'Active\', "Revenue", 0))'),
    description: z
      .string()
      .optional()
      .describe("Optional. New description for the aggregate formula."),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, formulaId, expression, description, orgId }) => {
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
          const wsInst = ac.getWorkspaceInstance(org_id, workspace);
          const sdkConfig: Record<string, string> = {};
          if (description) {
            sdkConfig.description = description;
          }
          await (wsInst as any).editAggregateFormula(formulaId, expression, sdkConfig);
          return ToolResponse(`Aggregate formula (ID: ${formulaId}) updated successfully.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while editing the aggregate formula");
    }
  },
});

defineTool({
  name: "deleteCustomFormulaColumn",
  description: `
    1. Use Case:
    - Delete an existing custom formula column from a table in Zoho Analytics.
    - Use this when the user wants to permanently remove a formula column from a table.

    2. Important Notes:
    - Use listCustomFormulaColumns to find the formulaId of the formula column you want to delete.
    - This operation is irreversible. Confirm with the user before proceeding.

    3. Arguments:
    - workspaceId (str): The ID of the workspace.
    - tableId (str): The ID of the table (view) that owns the formula column.
    - formulaId (str): The ID of the formula column to delete.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - str: Success message, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    tableId: z.string().describe("The ID of the table (view) that owns the formula column"),
    formulaId: z.string().describe("The ID of the formula column to delete"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, tableId, formulaId, orgId }) => {
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
          const viewInst = ac.getViewInstance(org_id, workspace, tableId);
          await (viewInst as any).deleteFormulaColumn(formulaId);
          return ToolResponse(`Custom formula column (ID: ${formulaId}) deleted successfully.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while deleting the custom formula column");
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
        const validation = validateChartCompatibility(chartType, inputAxisColumns);
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

defineTool({
  name: "createFolder",
  description: `
    Use Case:
    1) Creates a folder under a specified workspace to organize views (tables, reports, dashboards).
    2) Use this to organize workspace assets into folders for better structure and management.

    Important Notes:
    1) Folders support exactly 2 levels of nesting: a workspace can contain any number of root-level folders (level 1), 
       and each root-level folder can contain any number of sub-folders (level 2).
    2) Sub-folders cannot contain further nested folders - only 1 level of sub-folders is supported.
    3) To create a sub-folder, provide parentFolderId (use getFolders to obtain the parent folder ID).
    4) Omit parentFolderId to create a root-level folder.
    5) After creating a folder, use moveViewsToFolder to organize existing views into it.

    Arguments:
    - workspaceId (str): The ID of the workspace where the folder will be created.
    - folderName (str): Required. Display name for the new folder.
    - folderDesc (str | optional): A brief description of the folder.
    - parentFolderId (str | optional): Only provide this to create a sub-folder. Use getFolders to obtain the parent folder ID. 
      Note: only 1 level of sub-folders is supported, so the parent must be a root-level folder.
    - makeDefaultFolder (boolean | optional): Set to true to make this folder the default. Defaults to false.
    - orgId (str | optional): The ID of the organization. Defaults to config.ORGID if not provided.

    Returns:
    - A success message with the created folder ID.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace where the folder will be created"),
    folderName: z.string().describe("Required. Display name for the new folder"),
    folderDesc: z.string().optional().describe("Optional. A brief description of the folder"),
    parentFolderId: z.string().optional().describe("Optional. Provide this to create a sub-folder (use getFolders to get parent folder ID). Only 1 level of sub-folders is supported"),
    makeDefaultFolder: z.boolean().optional().describe("Optional. Set to true to make this folder the default. Defaults to false"),
    orgId: z.string().optional().describe("The ID of the organization. Defaults to config.ORGID if not provided"),
  },
  handler: async ({ workspaceId, folderName, folderDesc, parentFolderId, makeDefaultFolder, orgId }) => {
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
          
          const config: any = {};
          if (folderDesc) config.folderDesc = folderDesc;
          if (parentFolderId) config.parentFolderId = parentFolderId;
          if (makeDefaultFolder !== undefined) config.makeDefaultFolder = makeDefaultFolder;

          const folderId = await (workspaceInst as any).createFolder(folderName, config);
          return ToolResponse(`Folder '${folderName}' created successfully. Folder ID: ${folderId}`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while creating the folder");
    }
  },
});

defineTool({
  name: "moveViewsToFolder",
  description: `
    Use Case:
    1) Move one or more views (tables, query tables, reports, charts, or dashboards) into a specified folder within a workspace.
    2) Use this to organize workspace assets into folders after creation, or to reorganize existing views.

    Important Notes:
    1) Use getFolders to look up the target folder ID.
    2) Use searchViews or getViewDetails to look up the view IDs to move.
    3) All specified views will be moved to the target folder.

    Typical Workflow:
    1) getFolders to get the target folder ID
    2) searchViews to get the view IDs to move
    3) moveViewsToFolder

    Arguments:
    - workspaceId (str): The ID of the workspace containing the views.
    - folderId (str): Required. The destination folder ID (use getFolders to obtain).
    - viewIds (array[str]): Required. An array of view IDs to move (use searchViews to obtain).
    - orgId (str | optional): The ID of the organization. Defaults to config.ORGID if not provided.

    Returns:
    - A success message confirming the views were moved.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the views"),
    folderId: z.string().describe("Required. The destination folder ID (use getFolders to obtain)"),
    viewIds: z.array(z.string()).describe("Required. An array of view IDs to move (use searchViews to obtain)"),
    orgId: z.string().optional().describe("The ID of the organization. Defaults to config.ORGID if not provided"),
  },
  handler: async ({ workspaceId, folderId, viewIds, orgId }) => {
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
          
          await (workspaceInst as any).moveViewsToFolder(folderId, viewIds, {});
          return ToolResponse(`Successfully moved ${viewIds.length} view(s) to folder ${folderId}.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while moving views to folder");
    }
  },
});

defineTool({
  name: "renameFolder",
  description: `
    Use Case:
    1) Rename an existing folder in a workspace, and optionally update its description.
    2) Use this when you need to change a folder's display name or update its description.

    Important Notes:
    1) Use getFolders to look up the folder ID before calling this endpoint.
    2) The folder ID remains the same; only the name and/or description are updated.

    Arguments:
    - workspaceId (str): The ID of the workspace containing the folder.
    - folderId (str): Required. The ID of the folder to rename (use getFolders to obtain).
    - folderName (str): Required. The new display name for the folder.
    - folderDesc (str | optional): Updated description for the folder.
    - orgId (str | optional): The ID of the organization. Defaults to config.ORGID if not provided.

    Returns:
    - A success message confirming the folder was renamed.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the folder"),
    folderId: z.string().describe("Required. The ID of the folder to rename (use getFolders to obtain)"),
    folderName: z.string().describe("Required. The new display name for the folder"),
    folderDesc: z.string().optional().describe("Optional. Updated description for the folder"),
    orgId: z.string().optional().describe("The ID of the organization. Defaults to config.ORGID if not provided"),
  },
  handler: async ({ workspaceId, folderId, folderName, folderDesc, orgId }) => {
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
          
          const config: any = {};
          if (folderDesc) config.folderDesc = folderDesc;

          await (workspaceInst as any).renameFolder(folderId, folderName, config);
          return ToolResponse(`Folder ${folderId} renamed to '${folderName}' successfully.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while renaming the folder");
    }
  },
});

defineTool({
  name: "deleteFolder",
  description: `
    Use Case:
    1) Permanently delete a folder from a workspace.
    2) Optionally delete all views contained within the folder and their dependents.

    Important Notes:
    1) Use getFolders to look up the folder ID.
    2) If the folder contains views you want to preserve, move them first using moveViewsToFolder before deleting the folder.
    3) Setting deleteDependentViews to true will delete all views inside the folder along with their dependents.
    4) If deleteDependentViews is false or omitted, the folder must be empty to be deleted successfully.

    Typical Workflow:
    1) getFolders to get the folder ID
    2) (optional) moveViewsToFolder to relocate views you want to keep
    3) deleteFolder

    Arguments:
    - workspaceId (str): The ID of the workspace containing the folder.
    - folderId (str): Required. The ID of the folder to delete (use getFolders to obtain).
    - deleteDependentViews (boolean | optional): When true, deletes all views inside the folder along with their dependents. 
      Defaults to false, which deletes only the empty folder.
    - orgId (str | optional): The ID of the organization. Defaults to config.ORGID if not provided.

    Returns:
    - A success message confirming the folder was deleted.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the folder"),
    folderId: z.string().describe("Required. The ID of the folder to delete (use getFolders to obtain)"),
    deleteDependentViews: z.boolean().optional().describe("Optional. When true, deletes all views inside the folder along with their dependents. Defaults to false"),
    orgId: z.string().optional().describe("The ID of the organization. Defaults to config.ORGID if not provided"),
  },
  handler: async ({ workspaceId, folderId, deleteDependentViews, orgId }) => {
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
          
          // The SDK deleteFolder method doesn't accept config parameter, so we need to call the API directly
          // when deleteDependentViews is provided
          if (deleteDependentViews !== undefined) {
            const deleteConfig: any = { deleteDependentViews };
            const uriPath = `/restapi/v2/workspaces/${workspace}/folders/${folderId}`;
            const header: any = { 'ZANALYTICS-ORGID': org_id };
            await ac.handleV2Request(uriPath, "DELETE", deleteConfig, header);
          } else {
            const workspaceInst = ac.getWorkspaceInstance(org_id, workspace);
            await (workspaceInst as any).deleteFolder(folderId);
          }
          
          return ToolResponse(`Folder ${folderId} deleted successfully from workspace ${workspace}.`);
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while deleting the folder");
    }
  },
});
