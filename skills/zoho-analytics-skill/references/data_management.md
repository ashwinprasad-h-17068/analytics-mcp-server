# Data Management

Data Management operations cover inserting data into tables and retrieving data via SQL queries. Use these operations when the task is about the *contents* of a table — importing rows or running SELECT queries — rather than the table's structure (use Table Schema Management for that).


## 1. Import Data

Imports rows into an existing table within a workspace. Data can be supplied inline as a JSON array or from a local file (CSV or JSON format).

**Prerequisites:**
- The target table must already exist. If it doesn't, use `create_table` first.
- Before creating a table for import, inspect the source data to determine the correct column names and data types.
- If the source is a remote URL, download the file to a local path before calling this tool — remote URLs are not supported by `filePath`.

Arguments:
- workspaceId (required): The ID of the workspace that contains the target table.
- tableId (required): The ID of the table to import data into.
- data (optional): Inline data as an array of JSON objects. Each object represents one row; keys must match existing column names in the table. Used when no `filePath` is provided.
- filePath (optional): Absolute path to a local CSV or JSON file containing the data to import. Takes precedence over `data` if both are provided.
- fileType (optional): Format of the file at `filePath`. Required when `filePath` is provided. Accepted values: `"csv"` or `"json"`.
- orgId (optional): Organization ID associated with the workspace. Required for shared workspaces; falls back to the configured default if omitted.

Important Notes:
- If both `data` and `filePath` are provided, `filePath` takes precedence.
- Column keys in `data` (or column headers in the CSV/JSON file) must exactly match the column names defined in the target table.

```
execute_analytics_tool(
    "importData",
    {
        "workspaceId": "<workspace_id>",
        "tableId": "<table_id>",
        "data": [<json_objects>],
        "filePath": "<absolute_local_file_path>",
        "fileType": "<csv|json>",
        "orgId": "<org_id>"
    }
)
```

Example — inline JSON:

```
execute_analytics_tool(
    "importData",
    {
        "workspaceId": "123456789",
        "tableId": "456789123",
        "data": [
            {"Order ID": "ORD-001", "Customer ID": "CUST-42", "Amount": 149.99, "Order Date": "2024-06-01"},
            {"Order ID": "ORD-002", "Customer ID": "CUST-17", "Amount": 89.50,  "Order Date": "2024-06-02"}
        ]
    }
)
```

Example — local CSV file:

```
execute_analytics_tool(
    "importData",
    {
        "workspaceId": "123456789",
        "tableId": "456789123",
        "filePath": "/tmp/orders_june.csv",
        "fileType": "csv"
    }
)
```


## 2. Query Data

Executes a SQL SELECT query on the specified workspace and returns the top N rows as results. Use this to retrieve data, gather insights, and answer natural language questions by analyzing query results.

Arguments:
- workspaceId (required): The ID of the workspace where the query will be executed.
- sqlQuery (required): A MySQL-compatible SELECT query. DDL and DML statements are not supported — use the relevant schema or import operations for those.

Important Notes:
- Always include a `LIMIT` clause. Use aggregate functions (`COUNT`, `SUM`, `AVG`, etc.) wherever possible to minimize data transfer and avoid fetching raw rows unnecessarily. This matters because only the top N rows are returned; the first tool response will indicate the actual value of N.
- To paginate beyond the first N rows, use `LIMIT` with `OFFSET`:
  - Page 1: `LIMIT N OFFSET 0`
  - Page 2: `LIMIT N OFFSET N`
  - Page 3: `LIMIT N OFFSET 2N`
- Enclose table or column names that contain spaces or special characters in double quotes.
- Do not use more than one level of nested sub-queries.
- Combine multiple lookups into a single query using JOINs, UNIONs, or sub-queries where possible.

Returns: Top N rows as JSON with `columns` and `rows` arrays, or an error message if the query fails.

```
execute_analytics_tool(
    "queryData",
    {
        "workspaceId": "<workspace_id>",
        "sqlQuery": "<mysql_compatible_select_query>"
    }
)
```

Example:

```
execute_analytics_tool(
    "queryData",
    {
        "workspaceId": "123456789",
        "sqlQuery": "SELECT product_name, SUM(sales) AS total_sales FROM sales_data GROUP BY product_name ORDER BY total_sales DESC LIMIT 5"
    }
)
```