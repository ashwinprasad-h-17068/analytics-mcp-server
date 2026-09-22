---
name: zoho-analytics-skill
description: Interact with Zoho Analytics BI & Analytics platform to manage workspaces, tables, data, relationships, formulas, visualizations, and metadata. Supports OAuth 2.0 authentication with automatic token refresh.
---

# Zoho Analytics

Zoho Analytics is a business intelligence and analytics platform. This skill provides comprehensive access to the Zoho Analytics operations for managing workspaces, tables, data, relationships, formulas, visualizations, and metadata.


This skill provides programmatic access to the Zoho Analytics Operations, enabling:
- Workspace lifecycle management
- Table and schema operations
- Data import/export
- SQL-based query tables
- Relationships and formulas
- Charts, pivots, dashboards, and metadata


## Authentication

The tools used in the skill uses OAuth for authentication. You don't have to worry about providing any credentials or secrets, as the tools will handle the complete authentication process and token lifecycle for you. Just execute the tools as mentioned in the examples.

## Operation Categories

### Workspace Management

A workspace is a collection of related tables, query tables (views), charts, etc.

Workspace APIs are used when you need to:
- Create, copy, rename, or delete workspaces
- Fetch workspace-level metadata
- list views/objects in the workspace


Different types of Views/Objects in a workspace are:
- Tables (Ordinary Tables)
- Query Tables (SQL-based materialized views) - These are materialized views created using SQL queries, on top of existing base tables in the workspace.
- Reports
    - Charts
    - Pivot Tables
    - Summary Views

Refer to [Workspace Management](./references/workspace_management.md) for all available workspace operations that can be performed.

### Folder Management

Folders organize views (tables, reports, dashboards) within a workspace. Zoho Analytics supports 2 levels of nesting — root-level folders and one level of sub-folders.

If you need to:
- List existing folders and their IDs
- Create a new folder or sub-folder inside a workspace
- Rename a folder
- Move views (tables, reports, dashboards) into a folder
- Delete an empty folder

Refer to [Folder Management](./references/folder_management.md) for all available folder operations.

### Data Modelling

Data Modelling covers all structural operations in Zoho Analytics — how data is stored, shaped, and related across tables.

If you need to perform any operations such as:
- Creating a new table or adding/removing columns
- Getting the schema/structure of a table or query table
- Defining lookup relationships (foreign-key links) between tables
- Creating SQL-based query tables (materialized views)
- Creating aggregate formulas (KPI measures) or custom formula columns (row-level derived fields)

Refer to [Data Modelling](./references/data_modelling.md) which will guide you to the appropriate detailed reference.


### Data Management

These operations are concerned with reading from and writing to the actual data rows within tables.

If you need to perform any of the following:
- **Query data** — run a SQL SELECT to answer questions or retrieve records from tables/query tables
- **Export data** — export a view (table, report, query table) to a CSV file
- **Import data** — bulk-import rows into a table from a JSON array or a local CSV/JSON file
- **Add a row** — insert a single new row into a table
- **Update rows** — modify existing rows that match a given criteria
- **Delete rows** — remove rows that match a given criteria

Refer to [Data Management](./references/data_management.md) for the appropriate operation.


## Reports Creation and Management

These operations are concerned with creating and managing reports such as charts, pivots and summary views. These reports are created on top of tables and query tables in the workspace. if you need to create any operations like creating reports (charts, pivots, summary), or editing them (like applying a filter, changing the chart type, etc.), or deleting them, refer to [Reports Creation and Management](./references/reports_management.md) for all available report management operations that can be performed.


## Dashboard Management

A dashboard assembles multiple reports and content cards (HTML, images, titles, embedded URLs, user filter panels) into a single interactive view.

If you need to:
- Read the full configuration (layout, settings, themes) of an existing dashboard
- Create a new dashboard with a layout of report cards and other content
- Update an existing dashboard — rename it, add/remove/reposition cards, change visual themes, or modify behavior settings

Refer to [Dashboard Management](./references/dashboard_management.md) for all available dashboard operations.
