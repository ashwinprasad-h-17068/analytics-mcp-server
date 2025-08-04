import { z } from "zod";
import type { ServerInstance } from "../common";
import { getAnalyticsClient, config } from '../utils/apiUtil';


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
          
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(result)
            }]
          };
        } else {
          const allWorkspaces = await ac.getWorkspaces();
          const ownedWorkspaces = allWorkspaces.ownedWorkspaces || [];
          const sharedWorkspaces = allWorkspaces.sharedWorkspaces || [];
          const ownedResult = filterAndLimitWorkspaces(ownedWorkspaces, contains_str, true, MAX_WORKSPACES);
          const remainingCapacity = MAX_WORKSPACES - ownedResult.length;
          const sharedResult = filterAndLimitWorkspaces(sharedWorkspaces, contains_str, false, remainingCapacity);
          const combinedResult = [...ownedResult, ...sharedResult];
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(combinedResult)
            }]
          };
        }
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `An error occurred while fetching workspaces: ${error}` 
          }]
        };
      }
    });

    server.registerTool("get_view_list",
    {
        description: `
        <use_case>
            1) Fetches the list of views within a specified workspace.
            2) Used when user needs to retrieve the list of tables or reports or dashboards (any type of view) from a workspace
        </use_case>

        <important_notes>
            In Zoho Analytics, the term view can refer to different types of data representations or objects within a workspace. A view might be a table (raw data), a pivot table (summarized data), a query table (custom SQL logic), a report (visualization), or other related elements.

            Different types of views available in zoho analytics are:
            1. Table: A standard table
            2. Pivot Table: A table that summarizes data in a multidimensional format
            3. Query Table: A derived table created from a custom SQL query
            4. Chart: A graphical representation of data
            5. Dashboard: A collection of visualizations and reports 
            6. Summary View: A view that provides a simple tabular summary of your data with aggregate functions applied.
        </important_notes>

        <returns>
            A list of dictionaries, each representing a view with its details.
            If an error occurs, returns an error message.
        </returns>
        `,
        inputSchema: {
            workspace_id: z.string().describe("The ID of the workspace for which to fetch the views")
        }
    },
    async ({ workspace_id }) => {
      try {
          const analyticsClient = getAnalyticsClient();
          const workspace = analyticsClient.getWorkspaceInstance(config.ORGID || "", workspace_id);
          const views = await workspace.getViews();
          
          return {
              content: [
                  { 
                      type: "text", 
                      text: `Retrieved ${views.length} views from workspace.` 
                  },
                  {
                      type: "text",
                      text: JSON.stringify(views)
                  }
              ]
          };
      } catch (error) {
          return {
              content: [{ 
                  type: "text", 
                  text: `An error occurred while fetching views: ${error}` 
              }]
          };
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
            
            return {
                content: [
                    { 
                        type: "text", 
                        text: `Retrieved details for view ID: ${view_id}` 
                    },
                    {
                        type: "text",
                        text: JSON.stringify(viewDetails)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [{ 
                    type: "text", 
                    text: `An error occurred while fetching view details: ${error}` 
                }]
            };
        }
    }
    );
}
