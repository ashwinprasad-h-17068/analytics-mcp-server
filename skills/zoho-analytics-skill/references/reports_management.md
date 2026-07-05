# Reports Creation & Management

Reports are visualizations built on top of an existing table or query table in a workspace: charts, summary views, and pivot tables. All three report types are created through a single tool, `createReport` — the report type and its type-specific configuration are selected via arguments on that one call, rather than by picking between separate tools.

**Terminology note:** Data Management and Table Schema Management operations identify a table using `tableId`. These report-creation operations identify the base table using `tableName` instead — pass the table's name, not its ID.

## The `createReport` tool

Every report is created with the same call shape:
```
execute_analytics_tool(
    "createReport",
    {
        "workspaceId": "<workspace_id>",
        "tableName": "<table_name>",
        "reportName": "<report_name>",
        "reportType": "<chart|summary|pivot>",
        "chartConfig | summaryConfig | pivotConfig": { ... },
        "filters": [<filter_objects>]
    }
)
```

- workspaceId, tableName, reportName, reportType are always required.
- Provide exactly one config object, matching `reportType`:

| reportType | required config object | reference |
|---|---|---|
| `chart` | `chartConfig` | [Create Chart](./charts.md) |
| `summary` | `summaryConfig` | [Create Summary](./summary.md) |
| `pivot` | `pivotConfig` | [Create Pivot](./pivot.md) |

- `filters` is optional on every report type and shares one structure across all three — see [Filters](./filters.md).

Load the reference file matching the report type you're building; each one documents its config object's exact shape, valid `operation` values for that report type, and a filled-in example.