import { z } from "zod";
import path from "path";
import fs from "fs";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";
import {
  pollJobCompletion,
  QUERY_DATA_POLLING_INTERVAL,
  QUERY_DATA_QUEUE_TIMEOUT,
  QUERY_DATA_QUERY_EXECUTION_TIMEOUT,
  QUERY_DATA_ROW_LIMIT,
} from "../../utils/data-util";
import { enforceLimit } from "../../utils/sqlLimitEnforcer";

// ---- Tool Registration ----

defineTool({
  name: "queryData",
  description: `
    Executes a SQL query on the specified workspace and returns the top N rows as results.
    Use this to retrieve data from Zoho Analytics using custom SQL queries, gather insights,
    and answer natural language queries by analyzing the results.

    Use Cases:
    - Retrieve data from a Zoho Analytics workspace using custom SQL queries.
    - Gather insights from the data and answer user queries.
    - Answer natural language queries by analyzing SQL query results.

    Important Notes:
    - Always provide a MySQL-compatible SELECT query only.
    - Always include a LIMIT clause and use aggregate queries (COUNT, SUM, AVG, etc.) wherever possible
      to minimize data transfer and avoid fetching raw rows unnecessarily.
    - The tool enforces a maximum row cap of N rows - only the top N rows are returned.
    - To paginate through results beyond the first N rows, use LIMIT with OFFSET
      (e.g., LIMIT 20 OFFSET 20 for the next page).
    - If table or column names contain spaces or special characters, enclose them in double quotes.
    - Do not use more than one level of nested sub-queries.
    - Combine multiple lookups into a single query using JOINs, UNIONs, or sub-queries where possible.

    Pagination Strategy:
    Since only the top N rows are returned, use LIMIT + OFFSET to walk through data:
    - Page 1: LIMIT N OFFSET 0
    - Page 2: LIMIT N OFFSET N
    - Page 3: LIMIT N OFFSET 2N
    The first tool response will indicate the actual value of N.

    Returns:
    - Top N rows of the query result as JSON with columns and rows arrays.
    - If an error occurs, returns an error message.
  `,
  args: {
    workspaceId: z
      .string()
      .describe("The ID of the workspace where the query will be executed"),
    sqlQuery: z.string().describe("The SQL query to be executed"),
  },
  handler: async ({ workspaceId, sqlQuery }) => {
    try {
      try {
        sqlQuery = enforceLimit(sqlQuery, QUERY_DATA_ROW_LIMIT);
      } catch {
        // If limit enforcement fails for any reason, proceed with the original query
      }
      return await retryWithFallback(
        [config.ORGID || ""],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, sql) => {
          const analyticsClient = getAnalyticsClient();
          const bulk = analyticsClient.getBulkInstance(org_id, workspace);

          const jobId = await bulk.initiateBulkExportUsingSQL(sql, "CSV");

          const statusMessages: Record<string, string> = {
            error:
              "Some internal error occurred (Not likely due to the query). Please try again later.",
            queue_timeout:
              "Query Job accepted, but queue processing is slow. Please try again later.",
            execution_timeout:
              "Query is taking too long to execute, maybe due to the complexity. Please try a simpler query",
          };

          const errorMessage = await pollJobCompletion(
            bulk,
            jobId,
            statusMessages,
            QUERY_DATA_POLLING_INTERVAL,
            QUERY_DATA_QUEUE_TIMEOUT,
            QUERY_DATA_QUERY_EXECUTION_TIMEOUT
          );

          if (errorMessage) throw new Error(errorMessage);

          const allowedFileRoot = process.env.ALLOWED_FILE_ROOT;
          if (!allowedFileRoot) {
            throw new Error(
              "The ALLOWED_FILE_ROOT environment variable is not configured. " +
                "It is required for the queryData tool to work properly. " +
                "Please set ALLOWED_FILE_ROOT to a writable directory."
            );
          }
          const jobDir = path.join(allowedFileRoot, "job", jobId);
          fs.mkdirSync(jobDir, { recursive: true });
          const tmpFilePath = path.join(jobDir, `${jobId}.csv`);
          await bulk.exportBulkData(jobId, tmpFilePath);

          let csvData: string;
          try {
            csvData = fs.readFileSync(tmpFilePath, "utf8");
          } finally {
            if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
          }

          const rows: string[][] = csvData
            .trim()
            .split("\n")
            .map((line: string) => line.split(","));

          const columns: string[] = rows.shift() || [];
          const limitedRows: string[][] = rows.slice(0, QUERY_DATA_ROW_LIMIT);

          let responseMessage =
            `Query executed successfully. Retrieved ${limitedRows.length} rows.\n` +
            JSON.stringify({ columns, rows: limitedRows });

          if (limitedRows.length >= QUERY_DATA_ROW_LIMIT) {
            responseMessage =
              `Here are the top ${QUERY_DATA_ROW_LIMIT} rows for the given query (including the header row). ` +
              `It is possible (not confirmed) that there could be more rows this SELECT query could have produced. ` +
              `If you need more rows, adjust the OFFSET in the SELECT query. ` +
              `Note that the LIMIT cannot be increased beyond ${QUERY_DATA_ROW_LIMIT} due to system constraints.\n\n` +
              JSON.stringify({ columns, rows: limitedRows });
          }

          return ToolResponse(responseMessage);
        },
        workspaceId,
        sqlQuery
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while executing the query");
    }
  },
});
