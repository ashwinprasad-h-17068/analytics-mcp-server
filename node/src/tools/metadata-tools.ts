import { z } from "zod";
import type { ServerInstance } from "../common";
import { getAnalyticsClient, config } from '../utils/apiUtil';
import { retryWithFallback, ToolResponse, logAndReturnError } from "../utils/common";


const filterAndLimitWorkspaces = (workspaces: any[], filter: string | undefined, isOwned: boolean, limit: number) => {
  if (!workspaces || workspaces.length === 0) {
    return [];
  }
  
  let filtered = workspaces;
  
  // Apply filter if provided
  if (filter) {
    filtered = workspaces.filter(workspace => 
      workspace.workspaceName.toLowerCase().includes(filter.toLowerCase())
    );
  }
  
  // Apply limit
  if (filtered.length > limit) {
    filtered = filtered.slice(0, limit);
  }
  
  // Add owned flag to each workspace
  return filtered.map(workspace => ({
    ...workspace,
    owned: isOwned
  }));
};

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


async function getViews(
        orgId: string,
        workspaceId: string,
        allowedViewTypesIds: number[] = [0, 6],
        containsStr?: string,
        fromRelevantViewsTool = false
      ): Promise<View[] | string> {
        const analyticsClient = getAnalyticsClient();
        const workspace = analyticsClient.getWorkspaceInstance(orgId, workspaceId);

        let conf: GetViewsConfig = fromRelevantViewsTool
          ? { viewTypes: allowedViewTypesIds }
          : {
              viewTypes: allowedViewTypesIds,
              noOfResult: VIEW_RESULT_LIMIT + 1,
              sortedOrder: 0,
              sortedColumn: 0,
              startIndex: 1,
            };

        if (containsStr) {
          conf.keyword = containsStr;
        }

        const viewList = await workspace.getViews(conf);

        if (!viewList || (Array.isArray(viewList) && viewList.length === 0)) {
          return "No views found";
        }

        if (!fromRelevantViewsTool && Array.isArray(viewList) && viewList.length > VIEW_RESULT_LIMIT) {
          return `Too many views found. Please refine your search criteria to use contains_str parameter to filter views if view name is provided.
(or)
Use the search_views() tool with a natural language query to get relevant views based on user query.`;
        }

        return viewList;
      }


export function registerMetaDataTools(server: ServerInstance) {

  server.registerTool("get_workspaces_list",
    {
      description: `
      <use_case>
        1) Fetches the list of workspaces in the user's organization.
        2) Used in the scenario where the user needs to select a workspace for further operations.
      </use_case>

      <important_notes>
        1) Try to avoid setting include_shared_workspaces to True unless you specifically need to see shared workspaces.
        2) If you don't find a workspace from the owned workspaces, try setting include_shared_workspaces to True to see if the workspace is shared with you.
      </important_notes>

      <returns>
        A list of dictionaries, each representing a workspace with its details.
        If an error occurs, returns an error message.
      </returns>
      `,
      inputSchema: {
        include_shared_workspaces: z.boolean().describe("If True, includes shared workspaces in the list"),
        contains_str: z.string().optional().describe("Optional string to filter workspaces with a contains criteria")
      }
    },
    async ({ include_shared_workspaces, contains_str }) => {
      try {
        const MAX_WORKSPACES = 20;
        var ac = getAnalyticsClient();
        let allWorkspaces;
        if (!include_shared_workspaces) {
          const ownedWorkspaces = await ac.getOwnedWorkspaces();
          const result = filterAndLimitWorkspaces(ownedWorkspaces, contains_str, true, MAX_WORKSPACES);
          return ToolResponse(JSON.stringify(result));
        } else {
          const allWorkspaces = await ac.getWorkspaces();
          const ownedWorkspaces = allWorkspaces.ownedWorkspaces || [];
          const sharedWorkspaces = allWorkspaces.sharedWorkspaces || [];
          const ownedResult = filterAndLimitWorkspaces(ownedWorkspaces, contains_str, true, MAX_WORKSPACES);
          const remainingCapacity = MAX_WORKSPACES - ownedResult.length;
          const sharedResult = filterAndLimitWorkspaces(sharedWorkspaces, contains_str, false, remainingCapacity);
          const combinedResult = [...ownedResult, ...sharedResult];
          return ToolResponse(JSON.stringify(combinedResult));
        }
      } catch (err) {
        return logAndReturnError(err, "An error occurred while fetching workspaces");
      }
  });

  server.registerTool("get_view_details",
  {
      description: `
      <use_case>
          1) Fetches the details of a specific view in a workspace.
          2) Use this when you need detailed information about a specific view, such as its structure, data, and properties. (In case of a table, it will return the columns and their data types, dashboards will return the charts and their properties, etc.)
      </use_case>

      <returns>
          A dictionary containing the details of the specified view.
          If an error occurs, returns an error message.
      </returns>
      `,
      inputSchema: {
          view_id: z.string().describe("The ID of the view for which to fetch details")
      }
  },
  async ({ view_id }) => {
      try {
          const analyticsClient = getAnalyticsClient();
          let viewDetails = await analyticsClient.getViewDetails(view_id, { withInvolvedMetaInfo: true });

          if (viewDetails) {
              if ('orgId' in viewDetails) {
                  delete (viewDetails as any).orgId;
              }
              
              if ('createdByZuId' in viewDetails) {
                  delete (viewDetails as any).createdByZuId;
              }
              
              if ('lastDesignModifiedByZuId' in viewDetails) {
                  delete (viewDetails as any).lastDesignModifiedByZuId;
              }
              
              // Clean column details if they exist
              if ('columns' in viewDetails && Array.isArray(viewDetails.columns)) {
                  viewDetails.columns = (viewDetails as any).columns.map((column: any) => {
                      const columnCopy = {...column};
                      delete (columnCopy as any).dataTypeId;
                      delete (columnCopy as any).columnIndex;
                      delete (columnCopy as any).pkTableName;
                      delete (columnCopy as any).pkColumnName;
                      delete (columnCopy as any).formulaDisplayName;
                      delete (columnCopy as any).defaultValue;
                      return columnCopy;
                  });
              }
          }
          return ToolResponse(`Retrieved details for view ID: ${view_id}\n${JSON.stringify(viewDetails)}`);
      } catch (err) {
          return logAndReturnError(err, "An error occurred while fetching view details");
      }
  }
  );

  server.registerTool("search_views",
  {
    description: `
    <use_case>
      1) Searches for views in a workspace using either contains string name matching or natural language query via Retrieval-Augmented Generation (RAG).
      2) Use this when you need to find specific views or views relevant to a question.
    </use_case>

    <important_notes>
      - If view_contains_str is provided, performs simple string matching on view names.
      - If view_contains_str is None and natural_language_query is provided, performs intelligent RAG-based search using natural language.
      - If both view_contains_str and natural_language_query are provided, view_contains_str takes precedence and RAG search is not performed.
      - If both are None, returns views without filtering (may error if too many).
      - If not specified explicitly, uses [0, 6] as default allowedViewTypesIds (Table and Query Table).
    </important_notes>

    <returns>
      A JSON stringified array of views matching the criteria or an error message string.
    </returns>
    `,
    inputSchema: {
      workspaceId: z.string().describe("The ID of the workspace to search in."),
      natural_language_query: z.string().optional(),
      view_contains_str: z.string().optional(),
      allowedViewTypesIds: z.array(z.number()).optional(),
      orgId: z.string().nullable().optional(),
    },
  },
  async ({ workspaceId, natural_language_query, view_contains_str, allowedViewTypesIds, orgId }) => {
    try {
      if (!orgId) {
        orgId = config.ORGID || "";
      }
      return await retryWithFallback([orgId], workspaceId, "WORKSPACE", async (orgId, workspace, natLangQuery, view_str, allowedTypes) => {
        if (
          (view_str && view_str.trim() !== "") ||
          !natLangQuery ||
          natLangQuery.trim() === ""
          ) {
          const views = await getViews(orgId, workspace, allowedTypes ?? [0, 6], view_str, false);
          return ToolResponse(typeof views === "string" ? views : JSON.stringify(views));
        }

        // RAG search path
        const initialViews = await getViews(orgId, workspace, [0, 6], undefined, true);

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
          const viewsInBatch = currentViewList.slice(batchNumber * batchSize, (batchNumber + 1) * batchSize);

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
            const response = await server.server.createMessage({
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: prompt,
                  },
                },
              ],
              maxTokens: 500,
            });

            if (response.content.type !== "text") {
              return ToolResponse("Error in processing the RAG response. Please try again.");
            }

            console.log(
              JSON.stringify(
                {
                  epoch,
                  batch: batchNumber + 1,
                  prompt,
                  response: response.text,
                },
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

        if (!sampleSupported) {
          break;
        }

        console.log(`Epoch ${epoch} completed. Reduced from ${currentViewList.length} to ${filteredViewList.length} views`);
        currentViewList = filteredViewList;
        epoch++;
      }

      if (!sampleSupported) {
        console.log("Using fallback mechanism: Returning first 20 views from the workspace");
        return ToolResponse(JSON.stringify(transformedViewList.slice(0, 20)));
      }

      console.log(`Final result: ${currentViewList.length} views after ${epoch - 1} epochs`);
      return ToolResponse(JSON.stringify(currentViewList));
      }, workspaceId, natural_language_query, view_contains_str, allowedViewTypesIds);
    } catch (error) {
      return logAndReturnError(error, `Error in search_views: ${(error as Error).message || error}`);
    }
  });

}
