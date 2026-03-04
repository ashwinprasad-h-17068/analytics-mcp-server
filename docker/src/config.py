import os
from typing import Literal
from src.sdk.analytics_client import AnalyticsClient
from dotenv import load_dotenv
from fastmcp.server.dependencies import get_http_request
from starlette.requests import Request
from urllib.parse import urlparse
from ipaddress import ip_address, ip_network, IPv4Network, IPv6Network
import re

load_dotenv()


class Settings:

    @staticmethod
    def _get_accounts_url(project_domain: str) -> str:
        region_map = {
            ".zoho.in": "https://accounts.zoho.in",
            ".zoho.eu": "https://accounts.zoho.eu",
            ".zoho.com.au": "https://accounts.zoho.com.au",
            ".zoho.jp": "https://accounts.zoho.jp",
        }
        for suffix, url in region_map.items():
            if project_domain.endswith(suffix):
                return url
        return "https://accounts.zoho.com"

    @classmethod
    def _analytics_domain(cls) -> str:
        return urlparse(cls.ANALYTICS_SERVER_URL).netloc

    @classmethod
    def accounts_server_url(cls) -> str:
        return cls._get_accounts_url(cls._analytics_domain())


    @classmethod
    def oidc_provider_base_url(cls) -> str:
        return cls.accounts_server_url()


    # General Settings
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
    

    OIDC_PROVIDER_CLIENT_ID = os.getenv("OIDC_PROVIDER_CLIENT_ID")
    OIDC_PROVIDER_CLIENT_SECRET = os.getenv("OIDC_PROVIDER_CLIENT_SECRET")
    MCP_SERVER_PUBLIC_URL = os.getenv("MCP_SERVER_PUBLIC_URL")
    HOSTED_LOCATION = None # "LOCAL" or "REMOTE", set in startup
    SESSION_SECRET_KEY = os.getenv("SESSION_SECRET_KEY", "supersecretkey")
    PORT = int(os.getenv("PORT","4000"))
    MCP_SERVER_ORG_IDS = os.getenv("MCP_SERVER_ORG_IDS", "")
    BEHIND_PROXY = os.getenv("BEHIND_PROXY", "False").lower() == "true"
    TRUSTED_PROXY_LIST: list[IPv4Network | IPv6Network] = (
        [ip_network(ip.strip(), strict=False) 
         for ip in os.getenv("TRUSTED_PROXY_LIST", "").split(",") if ip.strip()]
        if BEHIND_PROXY else []
    )
    DEPOYMENT_SCENARIO: Literal["private_network", "public_network"]  = os.getenv("DEPOYMENT_SCENARIO", "private_network")
    _RAW_TRUSTED_IP_PATTERNS = [
        item.strip()
        for item in os.getenv("TRUSTED_PUBLIC_NETWORKS", "").split(",")
        if item.strip()
    ]

    _RAW_TRUSTED_DOMAIN_PATTERNS = [
        item.strip().lower()
        for item in os.getenv("TRUSTED_DOMAINS_ALLOWLIST", "").split(",")
        if item.strip()
    ]

    # Parsed structures
    TRUSTED_IP_NETWORKS: list[IPv4Network | IPv6Network] = []
    TRUSTED_IP_REGEX: list[re.Pattern] = []
    TRUSTED_DOMAIN_REGEX: list[re.Pattern] = []

    if DEPOYMENT_SCENARIO == "public_network":

        for pattern in _RAW_TRUSTED_IP_PATTERNS:
            try:
                # Try CIDR first
                TRUSTED_IP_NETWORKS.append(ip_network(pattern, strict=False))
            except ValueError:
                # Otherwise treat as regex
                TRUSTED_IP_REGEX.append(re.compile(pattern))

        for pattern in _RAW_TRUSTED_DOMAIN_PATTERNS:
            TRUSTED_DOMAIN_REGEX.append(re.compile(pattern))

    ## Persistence Settings for Remote
    STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "memory").lower()
    REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
    REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
    REDIS_PASSWORD = os.getenv("REDIS_PASSWORD")  

    # Catalyst Persistence Settings
    CATALYST_SDK_APP_NAME = os.getenv("CATALYST_SDK_APP_NAME", "ZohoAnalyticsRemoteMCPServer")
    CATALYST_PROJECT_ID = os.getenv("CATALYST_PROJECT_ID")
    CATALYST_ZAID = os.getenv("CATALYST_ZAID")
    CATALYST_ENVIRONMENT = os.getenv("CATALYST_ENVIRONMENT", "Production")
    CATALYST_CLIENT_ID = os.getenv("CATALYST_CLIENT_ID")
    CATALYST_CLIENT_SECRET = os.getenv("CATALYST_CLIENT_SECRET")
    CATALYST_REFRESH_TOKEN = os.getenv("CATALYST_REFRESH_TOKEN")
    CATALYST_CACHE_SEGMENT_ID = os.getenv("CATALYST_CACHE_SEGMENT_ID")
    CATALYST_PROJECT_DOMAIN = os.getenv("CATALYST_PROJECT_DOMAIN", "https://api.catalyst.zoho.in")


    CONSTANT_REMOTE_HOSTED_LOCATION = "REMOTE"
    CONSTANT_LOCAL_HOSTED_LOCATION = "LOCAL"


    OAUTH_DEFAULT_SCOPE = os.getenv("OAUTH_DEFAULT_SCOPE", "ZohoAnalytics.fullaccess.all")
    OAUTH_OFFLINE_ACCESS_SCOPE = os.getenv("OAUTH_OFFLINE_ACCESS_SCOPE", "offline_access")
    OAUTH_MAX_CLIENT_NAME_LENGTH = int(os.getenv("OAUTH_MAX_CLIENT_NAME_LENGTH", "80"))
    OAUTH_MAX_STRING_LENGTH = int(os.getenv("OAUTH_MAX_STRING_LENGTH", "256"))
    OAUTH_MAX_SCOPE_LENGTH = int(os.getenv("OAUTH_MAX_SCOPE_LENGTH", "100"))
    OAUTH_MAX_REDIRECT_URIS = int(os.getenv("OAUTH_MAX_REDIRECT_URIS", "3"))
    OAUTH_MAX_GRANT_TYPES = int(os.getenv("OAUTH_MAX_GRANT_TYPES", "2"))
    OAUTH_MAX_RESPONSE_TYPES = int(os.getenv("OAUTH_MAX_RESPONSE_TYPES", "1"))
    OAUTH_AUTH_TRANSACTION_TTL = int(os.getenv("OAUTH_AUTH_TRANSACTION_TTL", "120"))
    OAUTH_AUTH_CODE_TTL = int(os.getenv("OAUTH_AUTH_CODE_TTL", "120"))
    OAUTH_REGISTERED_CLIENTS_TTL = int(os.getenv("OAUTH_REGISTERED_CLIENTS_TTL", "36000"))
    OAUTH_CLIENT_IP_MAPPING_TTL = int(os.getenv("OAUTH_CLIENT_IP_MAPPING_TTL", "18000"))
    OAUTH_STANDARD_RATE_LIMIT_COUNT = int(os.getenv("OAUTH_STANDARD_RATE_LIMIT_COUNT", "5"))
    OAUTH_STANDARD_RATE_LIMIT_WINDOW = int(os.getenv("OAUTH_STANDARD_RATE_LIMIT_WINDOW", "60"))
    OAUTH_REGISTRATION_RATE_LIMIT_COUNT = int(os.getenv("OAUTH_REGISTRATION_RATE_LIMIT_COUNT", "10"))
    OAUTH_REGISTRATION_RATE_LIMIT_WINDOW = int(os.getenv("OAUTH_REGISTRATION_RATE_LIMIT_WINDOW", "3600"))
    OAUTH_MAX_CLIENTS_PER_IP = int(os.getenv("OAUTH_MAX_CLIENTS_PER_IP", "5"))


    @staticmethod
    def get_allowed_org_ids():
        """Parse comma-separated org IDs into a list, filtering out empty values."""
        if not Settings.MCP_SERVER_ORG_IDS:
            return []
        return [org_id.strip() for org_id in Settings.MCP_SERVER_ORG_IDS.split(",") if org_id.strip()]


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

    if Settings.HOSTED_LOCATION == Settings.CONSTANT_REMOTE_HOSTED_LOCATION:
        if access_token is None:
            access_token = get_access_token()
        client = AnalyticsClient.from_access_token(access_token)
        client.accounts_server_url = Settings.accounts_server_url()
        client.analytics_server_url = Settings.ANALYTICS_SERVER_URL
        return client


    global analytics_client
    if not analytics_client:
        analytics_client = AnalyticsClient.from_refresh_token(Settings.CLIENT_ID,  Settings.CLIENT_SECRET,  Settings.REFRESH_TOKEN)
        if Settings.accounts_server_url() is None or Settings.ANALYTICS_SERVER_URL is None:
            raise RuntimeError("ACCOUNTS_SERVER_URL (or) ANALYTICS_SERVER_URL environment variable is not set. Please set it to your Zoho Analytics accounts server URL and analytics server URL respectively.")
        analytics_client.accounts_server_url = Settings.accounts_server_url()
        analytics_client.analytics_server_url = Settings.ANALYTICS_SERVER_URL
    return analytics_client
    