from src.config import get_analytics_client_instance
import asyncio

async def add_row_implementation(org_id, workspace_id, table_id, columns):
    analytics_client = get_analytics_client_instance()
    view = analytics_client.get_view_instance(org_id, workspace_id, table_id)
    return await asyncio.to_thread(view.add_row,columns)

async def update_rows_implementation(org_id, workspace_id, table_id, criteria, columns):
    analytics_client = get_analytics_client_instance()
    view = analytics_client.get_view_instance(org_id, workspace_id, table_id)
    await asyncio.to_thread(view.update_row,columns, criteria)
    return "Rows updated successfully."

async def delete_rows_implementation(org_id, workspace_id, table_id, criteria):
    analytics_client = get_analytics_client_instance()
    view = analytics_client.get_view_instance(org_id, workspace_id, table_id)
    return await asyncio.to_thread(view.delete_row,criteria)