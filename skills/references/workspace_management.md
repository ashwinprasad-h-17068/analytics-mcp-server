# Workspace Management

Workspaces are the top-level containers in Zoho Analytics, similar to databases. They hold all the related tables, query tables, charts, dashboards, and other objects.

Based on the requirement, you can perform one of the below listed operations on workspaces:


### 1. Create a new Workspace

To create a new workspace, you can execute the tool `create_workspace` using the following arguments:

```
execute_analytics_tool(
    "create_workspace",
    {
        "name": "<workspace_name>",
        "description": "<workspace_description>"
    }
)
```

Example:

```
execute_analytics_tool(
    "create_workspace",
    {
        "name": "Sales Analytics",
        "description": "A workspace for analyzing sales data and generating insights."
    }
)
```

### 2. List workspaces

To list workspaces use, the `getWorkspaceList` tool.

The arguments are:

- includeSharedWorkspaces (optional): A boolean parameter to indicate whether the shared workspaces should also be included in the response or not. By default, this is set to false, which means only the workspaces owned by the user will be included in the response. If set to true, then both owned and shared workspaces will be included in the response. Ensure to only enable this parameter when you want to include shared workspaces in the response, as it may increase the response time if there are a large number of shared workspaces.

- containsStr (optional): A string parameter to filter the workspaces based on whether their names contain the specified string or not. This is a case-insensitive search. For example, if you want to filter workspaces that contain the string "sales", you can set this parameter to "sales", and it will return all workspaces with "sales" in their names, such as "Sales Analytics", "Global Sales Data", etc.

```
execute_analytics_tool(
    "getWorkspaceList",
    {
        "includeSharedWorkspaces": <true/false>,
        "containsStr": "<string_to_filter_workspaces_based_on_name>"
    }
)
```

```bash
execute_analytics_tool(
    "getWorkspaceList",
    {
        "includeSharedWorkspaces": true,
        "containsStr": "Sales"
    }
)
```

### 3. List Views/Objects in a Workspace

To list all the views/objects in a workspace, you can execute the below tool "" :

Arguments:

1. workspaceId (required): The unique identifier of the workspace for which you want to list the views/objects. You can get the workspaceId from the response of the "List Workspaces" API.

2. allowedViewTypesIds (optional): An array of numeric view type IDs to filter the views/objects. The different types of views/objects that can be listed are:
- 0 - Table
- 2 - Chart
- 3 - Pivot Table
- 4 - Summary View
- 6 - Query Table
- 7 - Dashboard

If not specified, view types of tables and query tables (0 and 6) will be returned by default.

3. viewContainsStr (optional): A string parameter to filter the views/objects based on whether their names contain the specified string or not. This is a case-insensitive search.

Note:

- This will only return 20 views at max. 
- Sometimes, workspaces might have huge number of views. Not all views will be relevant to handle the user query. In those cases, it is always recommended to use sub-agent to invoke this script using a paginated manner and write the temporary relevant results efficiently in some temp file. Once the top 20 most relevant views are fetched, the sub-agent can return those results back to the main agent for further processing.


Example:

```
execute_analytics_tool(
    "searchViews",
    {
        "workspaceId": "<workspace_id>",
        "allowedViewTypesIds": [0, 2],
        "viewContainsStr": "sales"
    }
)
```
