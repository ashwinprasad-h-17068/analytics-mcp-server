import { z } from "zod";
import { defineTool } from "../tool-registry";
import { getAnalyticsClient, config } from "../utils/apiUtil";
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";

// ---- Shared helpers ----

const VIEW_RESULT_LIMIT = 100;

type View = {
  viewId: string;
  viewName: string;
  viewDesc?: string;
  [key: string]: any;
};

type GetViewsConfig = {
  viewTypes: number[];
  noOfResult?: number;
  sortedOrder?: number;
  sortedColumn?: number;
  startIndex?: number;
  keyword?: string;
};

function filterValidNumbers(input: number[], validNumbers: number[]): number[] {
  const validSet = new Set(validNumbers);
  return input.filter((num) => validSet.has(num));
}

const filterAndLimitWorkspaces = (
  workspaces: any[],
  filter: string | undefined,
  isOwned: boolean,
  limit: number
) => {
  if (!workspaces || workspaces.length === 0) return [];
  let filtered = workspaces;
  if (filter) {
    filtered = workspaces.filter((w) =>
      w.workspaceName.toLowerCase().includes(filter.toLowerCase())
    );
  }
  if (filtered.length > limit) filtered = filtered.slice(0, limit);
  return filtered.map((w) => ({ ...w, owned: isOwned }));
};

async function getViews(
  org_id: string,
  workspace_id: string,
  allowed_view_types_ids: number[] = [0, 6],
  containsStr?: string,
  fromRelevantViewsTool = false
): Promise<View[] | string> {
  const analyticsClient = getAnalyticsClient();
  const workspace = analyticsClient.getWorkspaceInstance(org_id, workspace_id);
  allowed_view_types_ids = filterValidNumbers(allowed_view_types_ids, [0, 2, 3, 4, 6, 7]);

  const conf: GetViewsConfig = fromRelevantViewsTool
    ? { viewTypes: allowed_view_types_ids }
    : {
        viewTypes: allowed_view_types_ids,
        noOfResult: VIEW_RESULT_LIMIT + 1,
        sortedOrder: 0,
        sortedColumn: 0,
        startIndex: 1,
      };

  if (containsStr) conf.keyword = containsStr;

  const viewList = await workspace.getViews(conf);

  if (!viewList || (Array.isArray(viewList) && viewList.length === 0)) {
    return "No views found";
  }

  if (!fromRelevantViewsTool && Array.isArray(viewList) && viewList.length > VIEW_RESULT_LIMIT) {
    return (
      `Too many views found. Please refine your search criteria to use viewContainsStr parameter to filter views if view name is provided.\n` +
      `(or)\nUse the search_views tool with a natural language query to get relevant views based on user query.`
    );
  }

  return viewList;
}

// ---- Tool Registrations ----

defineTool({
  name: "listAggregateFormulas",
  description: `
    Use Case:
    1) Fetches the list of aggregate formulas in a workspace or a specific view/table.
    2) Use this to discover existing aggregate formulas and their expressions before creating new ones or referencing them in reports.

    Important Notes:
    1) If viewId is provided, fetches aggregate formulas for that specific view/table only.
    2) If viewId is not provided, fetches aggregate formulas for the entire workspace.
    3) If formulaNameContainsStr is provided, only formulas whose names contain that string (case-insensitive) are returned.

    Returns:
    A JSON array of aggregate formula objects. Each object contains:
    - formulaId: The unique identifier of the aggregate formula.
    - formulaName: The name of the aggregate formula.
    - expression: The SQL aggregate expression of the formula.
    - description: A description of the aggregate formula (if available).
    - subType: The data sub-type of the formula result (e.g. DECIMAL_NUMBER).
    - tableName: The name of the table the formula belongs to.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace"),
    viewId: z
      .string()
      .optional()
      .describe(
        "Optional. The ID of the view/table. If provided, fetches aggregate formulas for that specific view. If not provided, fetches for the entire workspace."
      ),
    formulaNameContainsStr: z
      .string()
      .optional()
      .describe(
        "Optional. If provided, filters and returns only those formulas whose names contain this string (case-insensitive)."
      ),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, viewId, formulaNameContainsStr, orgId }) => {
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
          let formulas: any[];

          if (viewId) {
            const viewInst = ac.getViewInstance(org_id, workspace, viewId);
            formulas = await (viewInst as any).getAggregateFormulas();
          } else {
            const workspaceInst = ac.getWorkspaceInstance(org_id, workspace);
            formulas = await (workspaceInst as any).getAggregateFormulas();
          }

          if (!formulas || formulas.length === 0) {
            return ToolResponse("No aggregate formulas found.");
          }

          // Apply name filter if provided
          if (formulaNameContainsStr && formulaNameContainsStr.trim() !== "") {
            const filterStr = formulaNameContainsStr.toLowerCase();
            formulas = formulas.filter(
              (f: any) => f.formulaName && f.formulaName.toLowerCase().includes(filterStr)
            );
            if (formulas.length === 0) {
              return ToolResponse(`No aggregate formulas found matching '${formulaNameContainsStr}'.`);
            }
          }

          // Return only the relevant fields
          const result = formulas.map((f: any) => ({
            formulaId: f.formulaId,
            formulaName: f.formulaName,
            expression: f.expression,
            description: f.description ?? "",
            subType: f.subType,
            tableName: f.tableName,
          }));

          return ToolResponse(JSON.stringify(result));
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching aggregate formulas");
    }
  },
});


defineTool({
  name: "getWorkspaceList",
  description: `
    <use_case>
      1) Fetches the list of workspaces in the user's organization.
      2) Used in the scenario where the user needs to select a workspace for further operations.
    </use_case>

    <important_notes>
      1) Try to avoid setting includeSharedWorkspaces to True unless you specifically need to see shared workspaces.
      2) If you don't find a workspace from the owned workspaces, try setting includeSharedWorkspaces to True to see if the workspace is shared with you.
    </important_notes>

    <returns>
      A list of dictionaries, each representing a workspace with its details.
      If an error occurs, returns an error message.
    </returns>
  `,
  args: {
    includeSharedWorkspaces: z
      .boolean()
      .describe("If True, includes shared workspaces in the list"),
    containsStr: z
      .string()
      .optional()
      .describe("Optional string to filter workspaces with a contains criteria"),
  },
  handler: async ({ includeSharedWorkspaces, containsStr }) => {
    try {
      const MAX_WORKSPACES = 20;
      const ac = getAnalyticsClient();
      if (!includeSharedWorkspaces) {
        const ownedWorkspaces = await ac.getOwnedWorkspaces();
        const result = filterAndLimitWorkspaces(ownedWorkspaces, containsStr, true, MAX_WORKSPACES);
        return ToolResponse(JSON.stringify(result));
      } else {
        const allWorkspaces = await ac.getWorkspaces();
        const ownedWorkspaces = allWorkspaces.ownedWorkspaces || [];
        const sharedWorkspaces = allWorkspaces.sharedWorkspaces || [];
        const ownedResult = filterAndLimitWorkspaces(ownedWorkspaces, containsStr, true, MAX_WORKSPACES);
        const remainingCapacity = MAX_WORKSPACES - ownedResult.length;
        const sharedResult = filterAndLimitWorkspaces(sharedWorkspaces, containsStr, false, remainingCapacity);
        return ToolResponse(JSON.stringify([...ownedResult, ...sharedResult]));
      }
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching workspaces");
    }
  },
});

defineTool({
  name: "getViewDetails",
  description: `
    <use_case>
      1) Fetches the details of a specific view in a workspace.
      2) Use this when you need detailed information about a specific view, such as its structure, data, and properties.
         (In case of a table, it will return the columns and their data types; dashboards will return the charts and their properties, etc.)
    </use_case>

    <returns>
      A dictionary containing the details of the specified view.
      If an error occurs, returns an error message.
    </returns>
  `,
  args: {
    viewId: z.string().describe("The ID of the view for which to fetch details"),
  },
  handler: async ({ viewId }) => {
    try {
      const analyticsClient = getAnalyticsClient();
      const viewDetails = await analyticsClient.getViewDetails(viewId, { withInvolvedMetaInfo: true });
      if (viewDetails) {
        if ("orgId" in viewDetails) delete (viewDetails as any).orgId;
        if ("createdByZuId" in viewDetails) delete (viewDetails as any).createdByZuId;
        if ("lastDesignModifiedByZuId" in viewDetails) delete (viewDetails as any).lastDesignModifiedByZuId;

        if ("columns" in viewDetails && Array.isArray((viewDetails as any).columns)) {
          (viewDetails as any).columns = (viewDetails as any).columns.map((column: any) => {
            const col = { ...column };
            delete col.dataTypeId;
            delete col.columnIndex;
            delete col.pkTableName;
            delete col.pkColumnName;
            delete col.formulaDisplayName;
            delete col.defaultValue;
            return col;
          });
        }
      }
      return ToolResponse(`Retrieved details for view ID: ${viewId}\n${JSON.stringify(viewDetails)}`);
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching view details");
    }
  },
});

defineTool({
  name: "searchViews",
  description: `
    use_case:
    1) Searches for views in a workspace using either contains string name matching or natural language query
       via Retrieval-Augmented Generation (RAG).
    2) Use this when you need to find specific views or views relevant to a question.

    important_notes:
    - If viewContainsStr is provided, performs simple string matching on view names.
    - If viewContainsStr is None and naturalLanguageQuery is provided, performs intelligent RAG-based search.
    - If both viewContainsStr and naturalLanguageQuery are provided, viewContainsStr takes precedence.
    - If both are None, returns views without filtering (may error if too many).
    - Default value for allowedViewTypesIds is [0, 6] (Table and Query Table).

    arguments:
    - workspaceId: The ID of the workspace to search in.
    - naturalLanguageQuery: Natural language query for intelligent search. Ignored if viewContainsStr is provided.
    - viewContainsStr: String to filter views by name matching. Takes precedence over naturalLanguageQuery.
    - allowedViewTypesIds: Optional array of view type IDs to filter results:
        0 - Table, 2 - Chart, 3 - Pivot Table, 4 - Summary View, 6 - Query Table, 7 - Dashboard
    - orgId: Organization ID. Defaults to config value if not provided.

    returns:
    - A JSON stringified array of views matching the criteria, or an error message string.
  `,
  args: {
    workspaceId: z.string(),
    naturalLanguageQuery: z.string().optional(),
    viewContainsStr: z.string().optional(),
    allowedViewTypesIds: z.array(z.number()).optional(),
  },
  handler: async (
    { workspaceId, naturalLanguageQuery, viewContainsStr, allowedViewTypesIds },
    ctx
  ) => {
    try {
      return await retryWithFallback(
        [config.ORGID || ""],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, natLangQuery, view_str, allowed_view_types_ids) => {
          // Simple string-match path (or no query provided)
          if ((view_str && view_str.trim() !== "") || !natLangQuery || natLangQuery.trim() === "") {
            const views = await getViews(org_id, workspace, allowed_view_types_ids ?? [0, 6], view_str, false);
            return ToolResponse(typeof views === "string" ? views : JSON.stringify(views));
          }

          // RAG search path
          const initialViews = await getViews(org_id, workspace, allowed_view_types_ids ?? [0, 6], undefined, true);

          if (typeof initialViews === "string" || !Array.isArray(initialViews) || initialViews.length === 0) {
            return ToolResponse("No views found in the workspace.");
          }

          const viewIdToDetails: Record<string, View> = {};
          const transformedViewList: View[] = [];

          initialViews.forEach((view) => {
            const filteredView: View = {
              viewId: view.viewId,
              viewName: view.viewName,
              viewDesc: view.viewDesc ?? "",
            };
            transformedViewList.push(filteredView);
            viewIdToDetails[view.viewId] = filteredView;
          });

          let currentViewList = transformedViewList;
          const batchSize = 15;
          const maxEpochs = 5;
          let epoch = 1;
          let sampleSupported = true;

          while (currentViewList.length > 15 && epoch <= maxEpochs && sampleSupported) {
            console.log(`Starting Epoch ${epoch} with ${currentViewList.length} views`);

            const filteredViewList: View[] = [];
            const numberOfBatches = Math.ceil(currentViewList.length / batchSize);

            for (let batchNumber = 0; batchNumber < numberOfBatches; batchNumber++) {
              const viewsInBatch = currentViewList.slice(
                batchNumber * batchSize,
                (batchNumber + 1) * batchSize
              );

              const prompt = `
You are an expert at identifying and ranking relevant views (tables, reports, dashboards) based on natural language queries.

EPOCH ${epoch} - BATCH ${batchNumber + 1}/${numberOfBatches}
Current views number in this epoch: ${currentViewList.length}
Views number in this batch: ${viewsInBatch.length}

Your task: Analyze the following views and rank them by relevance to the query. Return the TOP 5 MOST RELEVANT views from this batch based on your ranking.

Views in this batch:
${JSON.stringify(viewsInBatch)}

Natural language query: \`${natLangQuery}\`

Instructions:
1. Rank ALL views in this batch by relevance to the query
2. Select the TOP 5 most relevant views based on your ranking
3. If there are fewer than 5 views in the batch, return only the relevant views from them
4. Consider view names, descriptions, and how well they match the query intent
5. The output provided should be a properly escaped JSON and should not contain other formatting characters like new lines.

Strictly provide your output in the following JSON format:
{"relevant_views":[<list-of-top-5-view-ids-in-order-of-relevance>]}
`;

              try {
                const response = await ctx.server.server.createMessage({
                  messages: [
                    {
                      role: "user",
                      content: { type: "text", text: prompt },
                    },
                  ],
                  maxTokens: 500,
                });

                if (response.content.type !== "text") {
                  return ToolResponse("Error in processing the RAG response. Please try again.");
                }

                console.log(
                  JSON.stringify(
                    { epoch, batch: batchNumber + 1, prompt, response: response.content.text },
                    null,
                    2
                  )
                );

                const responseJson = JSON.parse(response.content.text);
                if (Array.isArray(responseJson.relevant_views)) {
                  responseJson.relevant_views.forEach((viewId: string) => {
                    if (viewIdToDetails[viewId]) {
                      filteredViewList.push(viewIdToDetails[viewId]);
                    }
                  });
                }
              } catch (e) {
                console.log(`Error during sampling: ${(e as Error).message || e}`);
                if (batchNumber === 0 && epoch === 1) {
                  console.log("Sampling is not supported in this environment");
                  sampleSupported = false;
                  break;
                }
                break;
              }
            }

            if (!sampleSupported) break;

            console.log(
              `Epoch ${epoch} completed. Reduced from ${currentViewList.length} to ${filteredViewList.length} views`
            );
            currentViewList = filteredViewList;
            epoch++;
          }

          if (!sampleSupported) {
            console.log("Using fallback mechanism: Returning first 20 views from the workspace");
            return ToolResponse(JSON.stringify(transformedViewList.slice(0, 20)));
          }

          console.log(`Final result: ${currentViewList.length} views after ${epoch - 1} epochs`);
          return ToolResponse(JSON.stringify(currentViewList));
        },
        workspaceId,
        naturalLanguageQuery,
        viewContainsStr,
        allowedViewTypesIds
      );
    } catch (error) {
      return logAndReturnError(error, `Error in search_views: ${(error as Error).message || error}`);
    }
  },
});

defineTool({
  name: "readReportMetadata",
  description: `
    1. Use Case:
    - Retrieve the full visual metadata (design configuration) of an existing report in Zoho Analytics.
    - Supports all report types: chart, pivot, and summary.

    2. Important Notes:
    - This is a read-only operation; it does not modify the report in any way.
    - The returned metadata includes the report's title, reportType, chartType (for chart reports),
      axisColumns, filters, and userFilters — the complete design configuration of the report.
    - Always call this tool first before updating a report (e.g., via the updateReport tool), because
      the update endpoint performs a full replacement of the axis, filter, and user-filter configuration.
      Inspect the current configuration here, modify the desired fields, then re-submit via the update tool.

    3. Arguments:
    - workspaceId (str): The ID of the workspace containing the report.
    - reportId (str): The ID of the report whose metadata should be retrieved.
    - orgId (str | None): The ID of the organization. Defaults to config.ORGID if not provided.

    4. Returns:
    - A JSON string containing the report metadata, or an error message.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the report"),
    reportId: z.string().describe("The ID of the report whose metadata to retrieve"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, reportId, orgId }) => {
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
          const metadata = await (workspaceInst as any).getReportMetadata(reportId);
          return ToolResponse(JSON.stringify(metadata, null, 2));
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while retrieving the report metadata");
    }
  },
});

defineTool({
  name: "getQueryTableDetails",
  description: `
    Use Case:
    - Fetches the details of a specific query table in a workspace, including its SQL query and column structure.
    - Use this when you need to inspect or review an existing query table before making changes.

    Important Notes:
    - The queryTableId must be the ID of a query table view (viewType: 6), not a regular table or report.

    Returns:
    - A JSON object containing the query table details (e.g., view name, SQL query, columns).
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace containing the query table"),
    queryTableId: z.string().describe("The ID of the query table to retrieve details for"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization to which the workspace belongs. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, queryTableId, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback(
        [orgId],
        workspaceId,
        "WORKSPACE",
        async (org_id, workspace, qtId) => {
          const ac = getAnalyticsClient();
          const workspaceInst = ac.getWorkspaceInstance(org_id, workspace);
          const details = await (workspaceInst as any).getQueryTableDetails(qtId);
          return ToolResponse(JSON.stringify(details));
        },
        workspaceId,
        queryTableId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching the query table details");
    }
  },
});

defineTool({
  name: "getFolders",
  description: `
    Use Case:
    1) List all folders in a specified workspace to discover the folder structure.
    2) Use this to get folder IDs before creating new views, moving views to folders, or when you need folder IDs for createFolder, moveViewsToFolder, or renameFolder operations.

    Important Notes:
    1) In Zoho Analytics, folders are used to organize views (tables, reports, dashboards) within a workspace.
    2) Returns folder metadata such as folder IDs, names, descriptions, default status, creator, and creation time.
    3) Folders support exactly 2 levels of nesting: a workspace can contain root-level folders (level 1), and each root-level folder can contain sub-folders (level 2).

    Returns:
    - A JSON array of folder objects. Each object contains:
      - folderId: The unique identifier of the folder.
      - folderName: The display name of the folder.
      - folderDesc: A description of the folder (if available).
      - isDefault: Boolean indicating if this is the default folder.
      - createdBy: Email address of the folder creator.
      - createdTime: Unix timestamp of when the folder was created.
    - An error message if the operation failed.
  `,
  args: {
    workspaceId: z.string().describe("The ID of the workspace to list folders from"),
    orgId: z
      .string()
      .optional()
      .describe("The ID of the organization. Defaults to config.ORGID if not provided."),
  },
  handler: async ({ workspaceId, orgId }) => {
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
          const folders = await (workspaceInst as any).getFolders();
          
          if (!folders || folders.length === 0) {
            return ToolResponse("No folders found in this workspace.");
          }

          return ToolResponse(JSON.stringify(folders, null, 2));
        },
        workspaceId
      );
    } catch (err) {
      return logAndReturnError(err, "An error occurred while fetching folders");
    }
  },
});


