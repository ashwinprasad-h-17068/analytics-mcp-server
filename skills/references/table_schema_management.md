# Table Schema Management

Tables are the core data structures for storing data in Zoho Analytics. They are a collection of rows and columns, where each column has a specific data type (e.g., string, number, date). Use Table Schema Management operations when you need to perform any operations relating to tables, such as creating a new table, modifying the table structure, adding or deleting columns, getting the structure/schema of a table/query table.

## Create a table

To create a new table in a workspace, you can execute the tool using:

```
execute_analytics_tool(
    "create_table",
    {
        "workspace_id": "<workspace_id>",
        "table_name": "<table_name>",
        "description": "<description>",
        "columns": <columns_json>
    }
)
```

Arguments:

- workspace_id (required): The unique identifier of the workspace in which you want to create the table.
- table_name (required): The name of the table to be created.
- description (optional): A brief description of the table and its purpose.
- columns (required): A JSON payload defining the columns of the table, including column names, data types, and other properties. It is an array of JSON objects, where each object represents a column definition.

Each column definition should include the following properties:
    - column_name (required): The name of the column.
    - data_type (required): The data type of the column.
    - description (optional): A brief description of the column and its purpose.

    Note:
    - The  supported data types for columns include PLAIN, MULTI_LINE, EMAIL, NUMBER, POSITIVE_NUMBER, POSITIVE_NUMBER, CURRENCY, DATE, BOOLEAN, URL.

Example:

```
execute_analytics_tool(
    "create_table",
    {
        "workspace_id": "<workspace_id>",
        "table_name": "Orders",
        "description": "Order header data",
        "columns": '[{"column_name": "Order ID", "data_type": "PLAIN", "description": "Unique identifier for the order"}, {"column_name": "Customer ID", "data_type": "PLAIN", "description": "Identifier for the customer who placed the order"}, {"column_name": "Amount", "data_type": "CURRENCY", "description": "Total amount for the order"}, {"column_name": "Order Date", "data_type": "DATE", "description": "Date when the order was placed"}]'
    }
)
```


## Add a column

To add a new column to an existing table, you can execute the below tool using:

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

Example (single column):

```
execute_analytics_tool(
    "add_column",
    {
        "workspace_id": "<workspace_id>",
        "table_id": "<table_id>",
        "column_name": "Customer ID",
        "data_type": "PLAIN",
        "description": "Identifier for the customer who placed the order"
    }
)
```

## Get table schema

Returns the current column definitions (schema) for a table.

Arguments:

- viewId (required): The unique identifier of the table/view for which you want to fetch the schema.

Example:

```
execute_analytics_tool(
    "getViewDetails",
    {
        "viewId": "<table_id>"
    }
)
```

Sample Response:

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