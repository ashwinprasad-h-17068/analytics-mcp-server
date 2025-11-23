import os
from AnalyticsClient import AnalyticsClient
from .utils.common import get_access_token

# Need to use pydantic to add validation
class Settings:
    CLIENT_ID = os.getenv("ANALYTICS_CLIENT_ID")
    CLIENT_SECRET = os.getenv("ANALYTICS_CLIENT_SECRET")
    REFRESH_TOKEN = os.getenv("ANALYTICS_REFRESH_TOKEN")
    ORG_ID = os.getenv("ANALYTICS_ORG_ID")
    MCP_DATA_DIR = os.getenv("ANALYTICS_MCP_DATA_DIR")
    ACCOUNTS_SERVER_URL = os.getenv("ACCOUNTS_SERVER_URL", "https://accounts.zoho.com")
    ANALYTICS_SERVER_URL = os.getenv("ANALYTICS_SERVER_URL", "https://analyticsapi.zoho.com")
    OIDC_PROVIDER_BASE_URL = os.getenv("OIDC_PROVIDER_BASE_URL", "")
    HOSTED_LOCATION = os.getenv("HOSTED_LOCATION", "")



analytics_client: AnalyticsClient  = None
def get_analytics_client_instance() -> AnalyticsClient:
    """
    Returns a singleton instance of the AnalyticsClient.
    If access_token is provided, returns a new AnalyticsClient instance using that token.
    Otherwise, returns (or creates) the singleton client using credentials from Settings.
    """

    if Settings.HOSTED_LOCATION == "REMOTE":
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
    