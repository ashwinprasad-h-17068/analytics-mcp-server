import os
from AnalyticsClient import AnalyticsClient
from dotenv import load_dotenv
from fastmcp.server.dependencies import get_http_request
from starlette.requests import Request

load_dotenv()

# Need to use pydantic to add validation
class Settings:

    # General Settings    
    ACCOUNTS_SERVER_URL = os.getenv("ACCOUNTS_SERVER_URL", "https://accounts.zoho.com")
    ANALYTICS_SERVER_URL = os.getenv("ANALYTICS_SERVER_URL", "https://analyticsapi.zoho.com")

    ## Tools
    ANALYTICS_WORKSPACE_LIST_RESULT_SIZE = int(os.getenv("ANALYTICS_WORKSPACE_LIST_RESULT_SIZE") or 20)
    ANALYTICS_VIEW_LIST_RESULT_SIZE = int(os.getenv("ANALYTICS_VIEW_LIST_RESULT_SIZE") or 15)
    QUERY_DATA_RESULT_ROW_LIMITS = int(os.getenv("QUERY_DATA_RESULT_ROW_LIMITS") or 20)
    QUERY_DATA_POLLING_INTERVAL = int(os.getenv("QUERY_DATA_POLLING_INTERVAL") or 4)
    QUERY_DATA_QUEUE_TIMEOUT = int(os.getenv("QUERY_DATA_QUEUE_TIMEOUT") or 120)
    QUERY_DATA_QUERY_EXECUTION_TIMEOUT = int(os.getenv("QUERY_DATA_QUERY_EXECUTION_TIMEOUT") or 30)

    # Settings required for Local
    CLIENT_ID = os.getenv("ANALYTICS_CLIENT_ID")
    CLIENT_SECRET = os.getenv("ANALYTICS_CLIENT_SECRET")
    REFRESH_TOKEN = os.getenv("ANALYTICS_REFRESH_TOKEN")
    MCP_DATA_DIR = os.getenv("ANALYTICS_MCP_DATA_DIR")
    ORG_ID = os.getenv("ANALYTICS_ORG_ID", "-1")
    
    # Settings required for Remote
    OIDC_PROVIDER_BASE_URL = os.getenv("OIDC_PROVIDER_BASE_URL", "")
    OIDC_PROVIDER_CLIENT_ID = os.getenv("OIDC_PROVIDER_CLIENT_ID")
    OIDC_PROVIDER_CLIENT_SECRET = os.getenv("OIDC_PROVIDER_CLIENT_SECRET")
    MCP_SERVER_PUBLIC_URL = os.getenv("MCP_SERVER_PUBLIC_URL")
    HOSTED_LOCATION = None # "LOCAL" or "REMOTE", set in startup
    SESSION_SECRET_KEY = os.getenv("SESSION_SECRET_KEY", "supersecretkey")
    PORT = int(os.getenv("PORT","4000"))


    ## Persistence Settings for Remote
    STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "memory").lower()
    REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
    REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))



def get_access_token():
    """
    For getting the access token from the MCP server.
    """
    request: Request = get_http_request()
    auth_header = request.headers.get("Authorization")
    access_token = auth_header.split(" ")[1]
    return access_token

analytics_client: AnalyticsClient  = None
def get_analytics_client_instance(access_token = None) -> AnalyticsClient:
    """
    Returns a singleton instance of the AnalyticsClient.
    If access_token is provided, returns a new AnalyticsClient instance using that token.
    Otherwise, returns (or creates) the singleton client using credentials from Settings.
    """

    if Settings.HOSTED_LOCATION == "REMOTE":
        if access_token is None:
            access_token = get_access_token()
        client = AnalyticsClient.from_access_token(access_token)
        client.accounts_server_url = Settings.ACCOUNTS_SERVER_URL
        client.analytics_server_url = Settings.ANALYTICS_SERVER_URL
        return client


    global analytics_client
    if not analytics_client:
        analytics_client = AnalyticsClient.from_refresh_token(Settings.CLIENT_ID,  Settings.CLIENT_SECRET,  Settings.REFRESH_TOKEN)
        if Settings.ACCOUNTS_SERVER_URL is None or Settings.ANALYTICS_SERVER_URL is None:
            raise RuntimeError("ACCOUNTS_SERVER_URL (or) ANALYTICS_SERVER_URL environment variable is not set. Please set it to your Zoho Analytics accounts server URL and analytics server URL respectively.")
        analytics_client.accounts_server_url = Settings.ACCOUNTS_SERVER_URL
        analytics_client.analytics_server_url = Settings.ANALYTICS_SERVER_URL
    return analytics_client
    