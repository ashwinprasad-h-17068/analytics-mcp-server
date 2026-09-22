# Data Modelling — Table Operations

Use these operations when you need to create a new table, add columns to an existing table, or inspect the schema of a table or query table.

---

## 1. Create a Table

Creates a new table in a workspace with a defined set of columns.

**Arguments:**
- `workspaceId` (required): The ID of the workspace in which to create the table.
- `tableName` (required): The display name for the new table.
- `columnsArr` (required): An array of column definition objects. Each object must include:
  - `columnName` (required): The name of the column.
  - `dataType` (required): The data type. Supported values:
    - `PLAIN` — plain text
    - `NUMBER` — integer numbers
    - `DECIMAL_NUMBER` — decimal numbers
    - `POSITIVE_NUMBER` — non-negative integers
    - `CURRENCY` — monetary values
    - `DATE` — date or datetime
    - `EMAIL` — email address
    - `URL` — web URL

```
execute_analytics_tool(
    "createTable",
    {
        "workspaceId": "<workspace_id>",
        "tableName": "<table_name>",
        "columnsArr": [
            { "columnName": "<col_name>", "dataType": "<data_type>" }
        ]
    }
)
```

**Example** — create an Orders table:

```
execute_analytics_tool(
    "createTable",
    {
        "workspaceId": "123456789",
        "tableName": "Orders",
        "columnsArr": [
            { "columnName": "Order ID",    "dataType": "PLAIN" },
            { "columnName": "Customer ID", "dataType": "PLAIN" },
            { "columnName": "Amount",      "dataType": "CURRENCY" },
            { "columnName": "Order Date",  "dataType": "DATE" }
        ]
    }
)
```

---

## 2. Add a Column

Adds a new column to an existing table.

**Arguments:**
- `workspace_id` (required): The ID of the workspace containing the table.
- `table_id` (required): The ID of the table to add the column to.
- `column_name` (required): The name of the new column.
- `data_type` (required): The data type of the column (same supported values as above).
- `description` (optional): A brief description of the column's purpose.

```
execute_analytics_tool(
    "add_column",
    {
        "workspace_id": "<workspace_id>",
        "table_id": "<table_id>",
        "column_name": "<column_name>",
        "data_type": "<data_type>",
        "description": "<description>"
    }
)
```

**Example:**

```
execute_analytics_tool(
    "add_column",
    {
        "workspace_id": "123456789",
        "table_id": "987654321",
        "column_name": "Region",
        "data_type": "PLAIN",
        "description": "Sales region for the order"
    }
)
```

---

## 3. Get Table Schema

Returns the current column definitions (schema) for a table or query table. Use this to discover column IDs and data types before performing operations that require them (e.g., creating lookups).

**Arguments:**
- `viewId` (required): The ID of the table or query table whose schema you want to fetch.

```
execute_analytics_tool(
    "getViewDetails",
    {
        "viewId": "<table_id>"
    }
)
```

**Example:**

```
execute_analytics_tool(
    "getViewDetails",
    {
        "viewId": "987654321"
    }
)
```

**Sample response:**

```json
{
    "columns": [
        {
            "column_id": 123456789,
            "column_name": "Order ID",
            "data_type": "PLAIN",
            "description": "Unique identifier for the order"
        },
        {
            "column_id": 111213141,
            "column_name": "Amount",
            "data_type": "CURRENCY",
            "description": "Total amount for the order"
        },
        {
            "column_id": 151617181,
            "column_name": "Order Date",
            "data_type": "DATE",
            "description": "Date when the order was placed"
        }
    ]
}
```

> **Tip:** The `column_id` values returned here are what you'll pass as `sourceColumnId` / `targetColumnId` / `columnId` in lookup operations.
