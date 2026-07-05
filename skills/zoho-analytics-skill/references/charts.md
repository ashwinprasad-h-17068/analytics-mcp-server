# Create Chart Reports

Creates a chart report on top of a table or query table, via the `createReport` tool with `reportType: "chart"` and a `chartConfig` object.

## Create Chart

Arguments (passed to `createReport`):
- workspaceId (required): The ID of the workspace to create the report in.
- tableName (required): Name of the base table for the report.
- reportName (required): Desired name for the report.
- reportType (required): Must be `"chart"`.
- chartConfig (required): Object —
  - chartType (required): The chart type. See "Supported chart types" below — the accepted values here are narrower than what the Zoho Analytics platform supports overall.
  - xAxis (required): Object — `columnName` (required), `operation` (required), `tableName` (optional, only needed when the column comes from a related table rather than the base table).
  - yAxis (required): Object — same shape as `xAxis`.
- filters (optional): List of filter objects — see [Filters](./filters.md).

## Supported chart types

`chartType` is validated against a fixed enum in the `createReport` tool and only accepts:
`bar`, `line`, `pie`, `scatter`, `bubble`.

## Operation values by data type

- String: `actual`, `count`, `distinctCount`
- Number: `sum`, `average`, `min`, `max`, `measure`, `dimension`, `count`, `distinctCount`
- Date: `year`, `month`, `week`, `fullDate`, `dateTime`, `range`, `count`, `distinctCount`

## Important notes

- If `yAxis.operation` is `actual`, `chartType` must be `scatter` — scatter is the only chart type that plots raw values point-by-point instead of an aggregate.
- For `bar`, `line`, `pie`, and `bubble` charts, `yAxis.operation` must not be `actual`; use an aggregate such as `sum` or `count`.
- For a numeric `xAxis` column in `bar`, `line`, `pie`, or `bubble` charts, use `dimension` rather than an aggregate operation — axis categories should not themselves be summed or averaged.
- `tableName` on `xAxis`/`yAxis` is optional but is preferred when a column from a different table than the report's base table is being used. If omitted, the tool assumes the column is on the base table.

```
execute_analytics_tool(
    "createReport",
    {
        "workspaceId": "<workspace_id>",
        "tableName": "<table_name>",
        "reportName": "<report_name>",
        "reportType": "chart",
        "chartConfig": {
            "chartType": "<bar|line|pie|scatter|bubble>",
            "xAxis": {"columnName": "<column_name>", "operation": "<operation>"},
            "yAxis": {"columnName": "<column_name>", "operation": "<operation>"}
        },
        "filters": [<filter_objects>]
    }
)
```

Example — total sales by product category as a bar chart:
```
execute_analytics_tool(
    "createReport",
    {
        "workspaceId": "123456789",
        "tableName": "Sales Data",
        "reportName": "Sales by Category",
        "reportType": "chart",
        "chartConfig": {
            "chartType": "bar",
            "xAxis": {"columnName": "Product Category", "operation": "actual"},
            "yAxis": {"columnName": "Sales Amount", "operation": "sum"}
        }
    }
)
```

Example — raw sales amount vs. discount as a scatter plot:
```
execute_analytics_tool(
    "createReport",
    {
        "workspaceId": "123456789",
        "tableName": "Sales Data",
        "reportName": "Sales vs Discount",
        "reportType": "chart",
        "chartConfig": {
            "chartType": "scatter",
            "xAxis": {"columnName": "Discount", "operation": "actual"},
            "yAxis": {"columnName": "Sales Amount", "operation": "actual"}
        }
    }
)
```