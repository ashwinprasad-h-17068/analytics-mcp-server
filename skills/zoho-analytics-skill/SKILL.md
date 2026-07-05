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

The tools used in the skill uses OAuth for authentication. You don't have to worry about providing any credentials or secrets, as the skill will handle the authentication process for you. Just execute the tools as mentioned in the examples and the skill will take care of the authentication and token refresh automatically.

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

### Table Schema Management 

Tables are the core data structures in Zoho Analytics. They can be created from scratch or imported from various sources.

Tables are a combination of rows and columns. Each column has a specific data type (e.g., string, number, date).

If you need to perform any operations relating to tables, such as 
- creating a new table
- modifying the table structure 
- adding or deleting columns
- defining lookup relationships (pk-fk relationships) between tables
- Getting the structure/schema of a table/query table

or any other DDL operations, refer to [Table Schema Management](./references/table_schema_management.md) for all available table schema management operations that can be performed.


### Data Management

These operations are concerned with managing the data within the tables such as fetching data to answer any data related queries.

If you need to perform any operations relating to data management, such as
- fetching data from tables: This is achieved using executing SQL Queries on top of tables and query tables in the workspace. 


For more information on all available data management operations that can be performed, refer to [Data Management](./references/data_management.md).


## Reports Creation and Management

These operations are concerned with creating and managing reports such as charts, pivots and summary views. These reports are created on top of tables and query tables in the workspace. if you need to create any operations like creating reports (charts, pivots, summary), or editing them (like applying a filter, changing the chart type, etc.), or deleting them, refer to [Reports Creation and Management](./references/reports_management.md) for all available report management operations that can be performed.
