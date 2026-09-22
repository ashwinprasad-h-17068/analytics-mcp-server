import { z } from "zod";
import path from "path";
import fs from "fs";
import { defineTool } from "../../tool-registry";
import { getAnalyticsClient, config } from "../../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../../utils/common";

// ---- Tool Registration ----

defineTool({
  name: "importData",
  description: `
    Imports data into an existing table within a specified workspace.

    Data can be provided in two ways:
    - Directly as a list of JSON objects (via the \`data\` parameter)
    - From a local file path (via \`filePath\`, with \`fileType\` set to "csv" or "json")

    PREREQUISITES:
    - The target table must already exist. If it doesn't, use \`createTable\` first.
    - Before creating a table, inspect the source data (file or inline) to determine
      the correct column names and data types.
    - If \`filePath\` points to a remote URL, download the file locally before using this tool.

    BEHAVIOR:
    - If both \`data\` and \`filePath\` are provided, \`filePath\` takes precedence.
    - For shared workspaces, \`orgId\` is required.

    returns:
    - A success message if the import completes, or a descriptive error message if it fails.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace that contains the target table."),
    tableId: z.string().describe("The ID of the table to import data into. "),
    data: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe(
        "Inline data to import, provided as an array of JSON objects. " +
          "Each object represents one row, with keys mapping to column names. " +
          "Used when no filePath is provided."
      ),
    filePath: z
      .string()
      .optional()
      .describe(
        "Absolute path to a local file (CSV or JSON) containing the data to import. " +
          "Remote URLs are not supported - download the file first if needed."
      ),
    fileType: z
      .enum(["csv", "json"])
      .optional()
      .describe(
        "Format of the file specified in filePath. " +
          "Required when filePath is provided. Accepted values: \"csv\" or \"json\"."
      ),
    orgId: z
      .string()
      .optional()
      .describe(
        "Organization ID associated with the workspace. " +
          "Required for shared workspaces. Falls back to the configured default if omitted."
      ),
  },
  handler: async ({ workspaceId, tableId, data, filePath, fileType, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }

      let resolvedFilePath = filePath;
      if (filePath) {
        const allowedFileRoot = process.env.ALLOWED_FILE_ROOT;
        if (!allowedFileRoot) {
          throw new Error(
            "The ALLOWED_FILE_ROOT environment variable is not configured. " +
              "It is required for the importData tool to work properly. " +
              "Please set ALLOWED_FILE_ROOT to the directory from which file imports are permitted."
          );
        }
        const normalizedRoot = path.resolve(allowedFileRoot);
        const tentativePath = path.resolve(filePath);
        if (
          tentativePath === normalizedRoot ||
          tentativePath.startsWith(normalizedRoot + path.sep)
        ) {
          resolvedFilePath = tentativePath;
        } else {
          resolvedFilePath = path.resolve(normalizedRoot, filePath);
          if (
            resolvedFilePath !== normalizedRoot &&
            !resolvedFilePath.startsWith(normalizedRoot + path.sep)
          ) {
            throw new Error(
              `The provided file path resolves outside the allowed file root directory (${normalizedRoot}). ` +
                `Please provide a file path that is within the allowed root.`
            );
          }
        }
      }

      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, table, input, filePath, type) => {
          const analyticsClient = getAnalyticsClient();
          const bulk = analyticsClient.getBulkInstance(org_id || "", workspace);

          if (filePath) {
            if ((filePath as string).startsWith("https")) {
              return ToolResponse(
                "File path cannot be a remote URL. Please download the file first and provide the local file path."
              );
            }
            if (!fs.existsSync(filePath)) {
              return ToolResponse(
                `File ${filePath} does not exist. Please provide a valid local file path.`
              );
            }
            if (!type || (type !== "csv" && type !== "json")) {
              return ToolResponse("File type must be specified as 'csv' or 'json'.");
            }
            const result = await bulk.importData(table, "append", type, "true", filePath, {
              delimiter: "0",
            });
            return ToolResponse(JSON.stringify(result));
          }

          if (!input) {
            return ToolResponse("No data provided to import. Please provide either 'data' or 'filePath'.");
          }

          const result = await bulk.importRawData(
            table,
            "append",
            "json",
            "true",
            JSON.stringify(input),
            { delimiter: "0" }
          );
          return ToolResponse(JSON.stringify(result));
        },
        workspaceId,
        tableId,
        data,
        resolvedFilePath,
        fileType
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while importing data into the table");
    }
  },
});
