# Data Management

Data Management operations are concerned with managing the data within the tables, such as inserting, updating, deleting, and fetching data.

### 1. Query Data

Executes a SQL query on the specified workspace and returns the top N rows as results. Use this to retrieve data from Zoho Analytics using custom SQL queries, gather insights, and answer natural language queries by analyzing the results.

Use Cases:
- Retrieve data from a Zoho Analytics workspace using custom SQL queries.
- Gather insights from the data and answer user queries.
- Answer natural language queries by analyzing SQL query results.

Arguments:

- workspaceId (required): The ID of the workspace where the query will be executed.
- sqlQuery (required): The SQL query to be executed. Must be a MySQL-compatible SELECT query.

Important Notes:

- Always provide a MySQL-compatible SELECT query only. DDL and DML SQL queries are not supported. For any DDL or DML operations, refer to the relevant sections in the documentation.
- Always include a LIMIT clause and use aggregate queries (COUNT, SUM, AVG, etc.) wherever possible to minimize data transfer and avoid fetching raw rows unnecessarily.
- The tool enforces a maximum row cap of N rows — only the top N rows are returned. The first tool response will indicate the actual value of N.
- To paginate through results beyond the first N rows, use LIMIT with OFFSET (e.g., LIMIT 20 OFFSET 20 for the next page).
- If table or column names contain spaces or special characters, enclose them in double quotes.
- Do not use more than one level of nested sub-queries.
- Combine multiple lookups into a single query using JOINs, UNIONs, or sub-queries where possible.

Pagination Strategy:

Since only the top N rows are returned, use LIMIT + OFFSET to walk through data:
- Page 1: LIMIT N OFFSET 0
- Page 2: LIMIT N OFFSET N
- Page 3: LIMIT N OFFSET 2N

Returns:
- Top N rows of the query result as JSON with columns and rows arrays.
- If an error occurs, returns an error message.

```
execute_analytics_tool(
    "queryData",
    {
        "workspaceId": "<workspace_id>",
        "sqlQuery": "<mysql_compatible_select_query>",
    }
)
```

Example:

```
execute_analytics_tool(
    "queryData",
    {
        "workspaceId": "123456789",
        "sqlQuery": "SELECT product_name, SUM(sales) as total_sales FROM sales_data GROUP BY product_name ORDER BY total_sales DESC LIMIT 5",
    }
)
```
