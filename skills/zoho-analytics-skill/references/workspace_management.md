# Workspace Management

Workspaces are the top-level containers in Zoho Analytics, similar to databases. They hold all related tables, query tables, charts, dashboards, and other objects. Use these operations to manage the workspace lifecycle and the views/objects within a workspace.

**Terminology note:** In Zoho Analytics, an ordinary Table *is* a type of View (view type 0). The operations below use "view" broadly - it covers tables, query tables, charts, pivots, dashboards, and so on. When an operation targets a specific table, pass its ID as the `viewId`.


## 1. Create a Workspace

Creates a new workspace.

Arguments:
- name (required): The display name of the new workspace.
- description (optional): A brief description of the workspace's purpose.

```
execute_analytics_tool(
    "createWorkspace",
    {
        "name": "<workspace_name>",
        "description": "<workspace_description>"
    }
)
```

Example:

```
execute_analytics_tool(
    "createWorkspace",
    {
        "name": "Sales Analytics",
        "description": "A workspace for analyzing sales data and generating insights."
    }
)
```


## 2. List Workspaces

Returns a list of workspaces accessible to the authenticated user.

Arguments:
- includeSharedWorkspaces (optional): When `true`, includes workspaces shared with the user in addition to workspaces the user owns. Defaults to `false`. Only enable when shared workspaces are relevant to the task - enabling it unnecessarily increases response time when many shared workspaces exist.
- containsStr (optional): Case-insensitive filter; returns only workspaces whose names contain the specified string (e.g. `"sales"` matches `"Sales Analytics"` and `"Global Sales Data"`).

```
execute_analytics_tool(
    "getWorkspaceList",
    {
        "includeSharedWorkspaces": <true/false>,
        "containsStr": "<string_to_filter_workspaces_based_on_name>"
    }
)
```

Example:

```
execute_analytics_tool(
    "getWorkspaceList",
    {
        "includeSharedWorkspaces": true,
        "containsStr": "Sales"
    }
)
```


## 3. List Views/Objects in a Workspace

Returns up to 20 views/objects within a workspace. Use the optional filters to narrow results to the types or names that are relevant to the current task.

Arguments:
- workspaceId (required): The unique identifier of the workspace. Obtain this from `getWorkspaceList`.
- allowedViewTypesIds (optional): Array of numeric view type IDs to restrict which kinds of objects are returned. Supported values:
  - `0` - Table
  - `2` - Chart
  - `3` - Pivot Table
  - `4` - Summary View
  - `6` - Query Table
  - `7` - Dashboard

  Defaults to `[0, 6]` (tables and query tables) if omitted.
- viewContainsStr (optional): Case-insensitive string filter on view names.

Important Notes:
- At most 20 views are returned per call. When a workspace has many views and only some are relevant, use paginated calls and write intermediate results to a temp file; return the top relevant matches once identified.

```
execute_analytics_tool(
    "searchViews",
    {
        "workspaceId": "<workspace_id>",
        "allowedViewTypesIds": [0, 6],
        "viewContainsStr": "<name_filter>"
    }
)
```

Example:

```
execute_analytics_tool(
    "searchViews",
    {
        "workspaceId": "123456789",
        "allowedViewTypesIds": [0, 2],
        "viewContainsStr": "sales"
    }
)
```


## 4. Delete a View

Deletes a view (table, report, dashboard, or any other object) from a workspace. This operation is irreversible - confirm you have the correct `viewId` before calling it.

Arguments:
- workspaceId (required): The ID of the workspace that contains the view to delete.
- viewId (required): The ID of the view to delete. Use `searchViews` to look up the ID if you don't already have it.
- orgId (optional): The ID of the organization to which the workspace belongs. Defaults to the configured `ORGID` if not provided. Required when working with views in a shared/org workspace that differs from the default org.

```
execute_analytics_tool(
    "deleteView",
    {
        "workspaceId": "<workspace_id>",
        "viewId": "<view_id>",
        "orgId": "<org_id>"
    }
)
```

Example:

```
execute_analytics_tool(
    "deleteView",
    {
        "workspaceId": "123456789",
        "viewId": "987654321"
    }
)
```


## 5. Create a Query Table

Creates a query table in a workspace. A query table is a materialized view defined by a SQL SELECT query over existing base tables in the same workspace. It behaves like a table for reporting and further querying purposes, but its data is derived from the SQL definition rather than stored directly.

Use this when you want to pre-join, filter, or aggregate data from base tables into a reusable named view without writing a raw SQL query every time.

Arguments:
- workspaceId (required): The ID of the workspace in which to create the query table.
- tableName (required): The display name for the new query table.
- query (required): A valid MySQL-compatible SELECT query referencing existing tables in the workspace. The same SELECT-only and quoting rules that apply to `queryData` apply here.
- orgId (optional): The ID of the organization to which the workspace belongs. Defaults to the configured `ORGID` if not provided.

Important Notes:
- The query must reference tables that already exist in the workspace; the tool will fail if a referenced table doesn't exist.
- Use double quotes around table or column names that contain spaces or special characters.
- Do not use more than one level of nested sub-queries.

```
execute_analytics_tool(
    "createQueryTable",
    {
        "workspaceId": "<workspace_id>",
        "tableName": "<query_table_name>",
        "query": "<mysql_compatible_select_query>",
        "orgId": "<org_id>"
    }
)
```

Example:

```
execute_analytics_tool(
    "createQueryTable",
    {
        "workspaceId": "123456789",
        "tableName": "Monthly Revenue Summary",
        "query": "SELECT DATE_FORMAT(\"Order Date\", '%Y-%m') AS month, SUM(Amount) AS total_revenue FROM Orders GROUP BY month ORDER BY month"
    }
)
```