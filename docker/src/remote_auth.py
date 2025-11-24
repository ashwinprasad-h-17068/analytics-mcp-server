"""
===========================================================================
OAUTH PROXY: DYNAMIC CLIENT REGISTRATION (DCR) MIMICRY IMPLEMENTATION
===========================================================================

### Requirement ###
-------------------------------
1.  Provider Constraint: The upstream OAuth provider, Zoho ACCOUNTS, supports 
    Static Client Registration only. It does not offer the necessary endpoints 
    or functionality for Dynamic Client Registration (DCR).

2.  Client Dependency: Model Context Protocol (MCP) Hosts (e.g., Cursor, Claude Desktop) 
    are designed to rely exclusively on DCR for seamless user onboarding and client setup.

This fundamental incompatibility necessitates an intermediate service.

### Solution and Mechanism ###
-----------------------------
This OAuth Proxy module is implemented to bridge the DCR requirement of the MCP clients 
with the static limitations of the Zoho Accounts provider.

1.  Pre-registration: A single client ID and Secret were acquired via a manual 
    Static Registration process with the upstream Zoho Accounts provider. This static 
    client serves as the credential pool for all users.

2.  DCR Interception: The proxy intercepts all client requests made to the DCR endpoint 
    (typically `/register`).

3.  Credential Masquerading: Instead of forwarding the registration request upstream (which would fail), 
    the proxy immediately returns a successful DCR response with generated credentials
    while it uses the pre-registered credentials for the acutal operations.
"""







from fastapi import Request, status, HTTPException, Query, Form, APIRouter
from fastapi.responses import RedirectResponse, HTMLResponse, JSONResponse
from config import Settings, get_analytics_client_instance
from urllib.parse import urljoin, urlencode, urlparse, urlunparse, parse_qsl, urlunsplit
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.status import HTTP_401_UNAUTHORIZED
import secrets
from pydantic import BaseModel, AnyHttpUrl
from typing import Optional, Dict
from datetime import datetime, timedelta, timezone, UTC
import uuid
from html import escape 
import httpx
from logging_util import get_logger

logger = get_logger(__name__)

authRouter = APIRouter()

# --- Configuration ---

UNAUTHENTICATED_PATHS = {
    "/register",
    "/authorize",
    "/consent",
    "/consent/approve",
    "/consent/deny",
    "/auth/callback",
    "/token",
    "/",
}


UNAUTHENTICATED_PREFIXES = (
    "/.well-known/",
)

class DynamicClientRegistrationRequest(BaseModel):
    redirect_uris: list[str] | None = None
    client_name: str | None = None
    scope: str | None = None
    grant_types: list[str] | None = None
    response_types: list[str] | None = None
    secret: str | None = None


class AuthorizationTransaction(BaseModel):
    created_at: datetime
    expires_at: datetime
    client_id: str
    redirect_uri: AnyHttpUrl
    scope: str
    state: Optional[str] = None
    code_challenge: Optional[str] = None
    code_challenge_method: Optional[str] = None


class AuthorizationCode(BaseModel):
    created_at: datetime
    expires_at: datetime
    transaction_id: str
    client_id: str
    redirect_uri: AnyHttpUrl
    code_challenge: Optional[str] = None
    code_challenge_method: Optional[str] = None
    upstream_location: str
    upstream_code: str


# REGISTERED_CLIENTS acts as an in-memory registry for all dynamically
# “created” OAuth clients. Since the upstream Zoho Accounts provider
# supports only Static Client Registration, the proxy must locally
# simulate Dynamic Client Registration (DCR).  
#
# When an MCP client sends a DCR request to `/register`, the proxy:
#   1. Generates a synthetic client_id and client_secret.
#   2. Stores the client’s metadata (redirect URIs, scopes, grant types,
#      response types, and the generated secret) in this dictionary.
#
# The key is the generated client_id (UUID4), and the value is an
# instance of DynamicClientRegistrationRequest containing the client’s
# configuration.  
type client_id_type = str
type transaction_id_type = str
type code_type = str

REGISTERED_CLIENTS: dict[client_id_type, DynamicClientRegistrationRequest] = {}

AUTH_TRANSACTIONS: dict[transaction_id_type, AuthorizationTransaction] = {}
AUTH_TRANSACTION_TTL_SECONDS = 600

AUTHORIZATION_CODES: dict[code_type, AuthorizationCode] = {}
AUTH_CODE_TTL_SECONDS = 600



class AuthMiddleware(BaseHTTPMiddleware):
    """
    Middleware to handle Bearer Token authentication for protected API routes.

    It bypasses authentication for specific public paths and well-known endpoints.
    For protected routes, it validates the Authorization header and attempts to
    validate the token by making an external call.

    Raises:
        HTTPException: 401 Unauthorized if the token is missing, invalid, or expired.
    """


    def _unauthorized_response(self, detail: str) -> JSONResponse:
        """Constructs the standardized 401 Unauthorized JSON response."""
        try:
            base = Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip("/") + "/"
        except NameError:
            base = "/" 
            
        return JSONResponse(
            status_code=HTTP_401_UNAUTHORIZED,
            content={"error": "unauthorized", "error_description": detail},
            headers={
                "WWW-Authenticate": 
                    f'Bearer realm="OAuth", resource_metadata="{urljoin(base, ".well-known/oauth-protected-resource")}"'
            }
        )

    
    async def dispatch(self, request: Request, call_next):

        path = request.url.path
        if path in UNAUTHENTICATED_PATHS or path.startswith(UNAUTHENTICATED_PREFIXES):
            logger.debug(f"Bypassing authentication for path: {path}")
            return await call_next(request)

        auth_header = request.headers.get("Authorization")
        if not auth_header:
            logger.warning(f"Missing Authorization header for path: {path}")
            return self._unauthorized_response("Missing Authorization header")

        try:
            scheme, token = auth_header.split()
            if scheme.lower() != "bearer":
                logger.warning(f"Invalid authorization scheme for path: {path}")
                return self._unauthorized_response("Authorization scheme must be Bearer")
            if not token:
                logger.warning(f"Empty token value for path: {path}")
                return self._unauthorized_response("Token value is empty")
            
            # The actual call to a protected resource to validate the token's active status.
            # We don't need the result, just that the call succeeded.
            analytics_client = get_analytics_client_instance(token)
            analytics_client.get_owned_workspaces()
            logger.debug(f"Token validated successfully for path: {path}")
            
        except ValueError:
            logger.warning(f"Invalid Authorization header format for path: {path}")
            return self._unauthorized_response("Invalid Authorization header format")

        except Exception as e:
            logger.error(f"Token validation failed for path: {path}", exc_info=True)
            return self._unauthorized_response("Invalid or expired token")
        return await call_next(request)


@authRouter.get("/.well-known/oauth-protected-resource")
async def oauth_protected_resource():
    """
    ## Proxy Protected Resource Metadata Endpoint

    Implements the Resource Server Metadata endpoint, detailing the characteristics
    of the protected resource managed by this proxy instance.

    All URIs returned here point to the proxy's public interface, 
    acting as the access point and intermediary for the MCP Clients.
    """
    logger.debug("Serving OAuth protected resource metadata")
    base = Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip("/") + "/"
    return {
        "resource": urljoin(base, "mcp"),
        "authorization_servers": [
            base
        ],
        "scopes_supported": [
            "ZohoAnalytics.fullaccess.all"
        ],
        "bearer_methods_supported": [
            "header"
        ]
    }


@authRouter.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server():
    """
    ## OAuth 2.0 Authorization Server Metadata (Discovery)

    - Implements the OAuth 2.0 Authorization Server Metadata endpoint.
    - This endpoint returns the Proxy's own URI structure for all OAuth flows. 
    - The MCP Clients interact only with these endpoints.
    """
    logger.debug("Serving OAuth authorization server metadata")
    base = Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip("/") + "/"
    return {
        "issuer": base,
        "authorization_endpoint": urljoin(base, "authorize"),
        "token_endpoint": urljoin(base, "token"),
        "registration_endpoint": urljoin(base, "register"),
        "scopes_supported": [
            "ZohoAnalytics.fullaccess.all"
        ],
        "response_types_supported": [
            "code"
        ],
        "grant_types_supported": [
            "authorization_code",
            "refresh_token"
        ],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post"
        ],
        "revocation_endpoint": urljoin(base, "revoke"),
        "revocation_endpoint_auth_methods_supported": [
            "client_secret_post"
        ],
        "code_challenge_methods_supported": [
            "S256"
        ]
    }


@authRouter.post("/register", status_code=status.HTTP_201_CREATED)
async def register_client(payload: DynamicClientRegistrationRequest):
    """
    ## Dynamic Client Registration (DCR) Endpoint

    Handles DCR requests from MCP Clients. This function acts as the Identity Broker by generating unique credentials and storing them internally, fully abstracting 
    the upstream Static-only OAuth provider (XXX Accounts).

    The generated credentials are owned and managed by the proxy, ensuring the upstream 
    Static Client ID/Secret remains protected and never exposed.
    """
    logger.info(f"Received client registration request with client_name: {payload.client_name}")

    client_id = str(uuid.uuid4())
    client_secret = secrets.token_urlsafe(32)
    base = Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip("/") + "/"


    REGISTERED_CLIENTS[client_id] = DynamicClientRegistrationRequest(
        redirect_uris=payload.redirect_uris or [],
        client_name=payload.client_name,
        scope=payload.scope,
        grant_types=payload.grant_types or ["authorization_code", "refresh_token"],
        response_types=payload.response_types or ["code"],
        secret=client_secret
    )

    logger.info(f"Client registered successfully: client_id={client_id}, client_name={payload.client_name}")

    return JSONResponse(content={
        "client_id": client_id,
        "client_secret": client_secret,
        "client_id_issued_at": int(__import__("time").time()),
        "token_endpoint_auth_method": "client_secret_post",
        "redirect_uris": payload.redirect_uris or [],
        "grant_types": payload.grant_types or ["authorization_code", "refresh_token"],
        "response_types": payload.response_types or ["code"],
        "scope": "ZohoAnalytics.fullaccess.all",
        "registration_client_uri": base + f"register/{client_id}",
        "registration_access_token": secrets.token_urlsafe(32)
    }, status_code=status.HTTP_200_OK)


def build_url_with_params(base_uri: str, params: dict[str, str | None]) -> str:
    """
    Append or merge query parameters into base_uri.
    """
    url = urlparse(base_uri)
    query = dict(parse_qsl(url.query))
    query.update({k: v for k, v in params.items() if v is not None})
    new_query = urlencode(query)
    new_url = url._replace(query=new_query)
    return urlunparse(new_url)


@authRouter.get("/authorize")
async def authorize(
        client_id: str = Query(...),
        redirect_uri: str = Query(...),
        scope: str = Query(""),
        state: str | None = Query(None),
        code_challenge: str | None = Query(None),
        code_challenge_method: str | None = Query(None)
    ):
    """
    ## OAuth 2.0 Authorization Endpoint (Initial Step)

    Implements the first step of the Authorization Code Grant flow, acting as the 
    authentication and transaction initialization layer for the OAuth Proxy.

    Functionality: This endpoint validates the client request and captures the full 
    set of parameters before redirecting the user to the consent screen.

    Process:
    1. Client Validation: Verifies the incoming `client_id` against the proxy's 
       internal client registry (`REGISTERED_CLIENTS`) established during DCR.

    2. Redirect Validation: Ensures the provided `redirect_uri` matches a 
       registered URI for the authenticated client.
       
    3. Transaction State Storage: All incoming request parameters (including 
       `scope`, `state`, and PKCE parameters) are temporarily stored in memory 
       under a unique `transaction_id`.
    4. Consent Redirection: The user agent is redirected to the proxy's internal 
       `/consent` page, using the `transaction_id` (`txid`) to retrieve the stored 
       request details upon user approval.

    Architectural Role: This endpoint strictly handles the MCP Client's request 
    validation and state management. It is designed to prepare the request before it 
    is eventually translated and forwarded to the upstream provider's `/authorize` 
    endpoint (a step handled *after* user consent).
    """

    client : DynamicClientRegistrationRequest = REGISTERED_CLIENTS.get(client_id)
    if not client:
        logger.warning(f"Authorization request with invalid client_id: {client_id}")
        raise HTTPException(status_code=400, detail="invalid_client")

    if redirect_uri not in (client.redirect_uris or []):
        logger.warning(f"Authorization request with invalid redirect_uri for client_id: {client_id}")
        raise HTTPException(status_code=400, detail="invalid_redirect_uri")
    
    logger.info(f"Creating authorization transaction for client_id: {client_id}")
    transaction_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    AUTH_TRANSACTIONS[transaction_id] = AuthorizationTransaction(
        created_at=now,
        expires_at=now + timedelta(seconds=AUTH_TRANSACTION_TTL_SECONDS),
        client_id=client_id,
        redirect_uri=redirect_uri,
        scope=scope or client.scope,
        state=state,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )


    base = Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip("/") + "/"
    consent_base = urljoin(base, "consent")

    consent_url = build_url_with_params(consent_base, {
        "transaction_id": transaction_id,
    })

    logger.debug(f"Redirecting to consent page for transaction_id: {transaction_id}")
    return RedirectResponse(url=consent_url, status_code=302)


@authRouter.get("/consent", response_class=HTMLResponse)
async def consent(transaction_id: str = Query(...)):
    logger.debug(f"Consent page requested for transaction_id: {transaction_id}")
    txn: AuthorizationTransaction = AUTH_TRANSACTIONS.get(transaction_id)
    if not txn:
        logger.warning(f"Invalid or missing transaction for transaction_id: {transaction_id}")
        raise HTTPException(status_code=400, detail="invalid_transaction")

    if txn.expires_at < datetime.now(timezone.utc):
        logger.warning(f"Expired transaction for transaction_id: {transaction_id}")
        AUTH_TRANSACTIONS.pop(transaction_id, None)
        raise HTTPException(status_code=400, detail="transaction_expired")

    
    client_id = escape(txn.client_id)
    scope = escape(txn.scope)
    transaction_id_escaped = escape(transaction_id)
    
    # Static info for the UI based on the problem description
    app_name = "Model Context Protocol (MCP) Host Application"
    upstream_provider = "Zoho ACCOUNTS" 

    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Authorize Access</title>
        <style>
            body {{
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background-color: #f4f7f6;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
            }}
            .container {{
                max-width: 500px;
                width: 90%;
                background-color: white;
                padding: 30px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            }}
            h1 {{
                color: #333;
                font-size: 24px;
                border-bottom: 2px solid #eee;
                padding-bottom: 10px;
                margin-bottom: 20px;
            }}
            .details-table {{
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 30px;
            }}
            .details-table th, .details-table td {{
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
            }}
            .details-table th {{
                background-color: #eef;
                color: #555;
                font-weight: 600;
                width: 40%;
            }}
            .details-table td {{
                color: #333;
                word-break: break-word; /* Ensure long IDs don't break layout */
            }}
            .consent-message {{
                background-color: #ffffe0;
                border-left: 5px solid #ffcc00;
                padding: 15px;
                margin-bottom: 20px;
                color: #666;
            }}
            form {{
                text-align: right;
            }}
            button {{
                padding: 10px 25px;
                background-color: #007bff;
                color: white;
                border: none;
                border-radius: 5px;
                font-size: 16px;
                cursor: pointer;
                transition: background-color 0.3s ease;
            }}
            button:hover {{
                background-color: #0056b3;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Authorize Access</h1>
            
            <p class="consent-message">
                The **{app_name}** application is requesting access to your data.
                By approving, you authorize this proxy to initiate the login process 
                with your **{upstream_provider}** account.
            </p>

            <table class="details-table">
                <tr>
                    <th>Application</th>
                    <td>{app_name}</td>
                </tr>
                <tr>
                    <th>Requested Scope</th>
                    <td>{scope}</td>
                </tr>
                <tr>
                    <th>Upstream Provider</th>
                    <td>**{upstream_provider}**</td>
                </tr>
                <tr>
                    <th>Client ID (MCP)</th>
                    <td><small>{client_id}</small></td>
                </tr>
            </table>

            <form action="/consent/approve" method="post">
                <input type="hidden" name="transaction_id" value="{transaction_id_escaped}">
                <button type="submit">✅ Approve and Continue</button>
            </form>
        </div>
    </body>
    </html>
    """

    return HTMLResponse(content=html, status_code=200)


@authRouter.post("/consent/approve")
async def approve_consent(transaction_id: str = Form(...)):
    """
    Handles user approval. Redirects the user's browser to the upstream
    provider's authorization endpoint using the proxy's static credentials
    and the transaction ID as the state parameter.
    """
    logger.info(f"User approved consent for transaction_id: {transaction_id}")
    txn: AuthorizationTransaction = AUTH_TRANSACTIONS.get(transaction_id)
    if not txn:
        logger.warning(f"Approval attempted for invalid transaction_id: {transaction_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_transaction")

    if txn.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc): 
        logger.warning(f"Expired transaction in approval flow for transaction_id: {transaction_id}")
        AUTH_TRANSACTIONS.pop(transaction_id, None)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="transaction_expired")

    # if txn["expires_at"] < datetime.now(timezone.utc): # UPDATED: Use timezone-aware datetime
    #     AUTH_TRANSACTIONS.pop(transaction_id, None)
    #     raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="transaction_expired")
    

    upstream_auth_endpoint = urljoin(
        Settings.OIDC_PROVIDER_BASE_URL.rstrip('/') + '/', 
        "oauth/v2/auth"
    )

    proxy_callback_uri = urljoin(Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip('/') + '/', "auth/callback")

    # Parameters required by the Upstream Provider
    # Crucially, we use the PROXY's static credentials and redirect URI,
    # and the transaction_id acts as the state to map back to the client's request.
    upstream_params = {
        # Static Client ID for the Proxy-to-Upstream connection
        "client_id": Settings.OIDC_PROVIDER_CLIENT_ID, 
        "response_type": "code",
        # Static Redirect URI for the Proxy-to-Upstream connection
        "redirect_uri": proxy_callback_uri,
        # Scope requested by the dynamic client, approved by the user
        "scope": txn.scope,
        # Use transaction ID as state to link upstream response to local transaction
        "state": transaction_id,
        "access_type": "offline",
        "prompt": "Consent"
        
        # Note: PKCE parameters (code_challenge/method) are NOT passed to the upstream
        # unless the proxy implementation is also fully PKCE-compliant with the upstream.
        # For a standard 3-legged flow with a server-side proxy, we generally omit them here.
    }
    
    upstream_auth_url = build_url_with_params(upstream_auth_endpoint, upstream_params)
    logger.info(f"Redirecting user to upstream authorization endpoint for transaction_id: {transaction_id}")
    return RedirectResponse(url=upstream_auth_url, status_code=status.HTTP_302_FOUND)



def build_error_redirect_url(base_url: str, params: Dict[str, str]) -> str:
    """Constructs a URL with query parameters, preserving existing structure."""
    parsed = urlparse(base_url)
    query = urlencode(params)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def ensure_aware_utc(dt: datetime) -> datetime:
    """
    Ensures a datetime object is timezone-aware (UTC) for comparison, 
    assuming naive datetimes (common in older in-memory objects) were intended to be UTC.
    """
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


@authRouter.get("/auth/callback")
async def proxy_callback(
    code: str = Query(...), 
    state: str = Query(...),
    location: str | None = Query(None)
):
    """
    ## 🔄 Proxy Callback Endpoint (Code Brokerage)

    This endpoint is the registered Redirect URI that the Upstream Provider redirects the user to after successful authorization. It marks the transfer of 
    control and the exchange of the upstream authorization code for a proxy-issued 
    authorization code.

    Functionality: It brokers the authorization code received from the upstream 
    provider and issues a new, distinct authorization code back to the dynamic MCP Client.

    Process:
    1. Transaction Validation: The incoming `state` (which corresponds to the 
       `transaction_id` stored earlier) is validated against the active in-memory 
       transactions (`AUTH_TRANSACTIONS`) to prevent CSRF and replay attacks.
    2. Upstream Code Capture: The `code` (the upstream authorization code) and 
       any provider-specific parameters (`location`, `accounts_server`) are captured 
       and stored within the transaction state.
    3. Proxy Code Issuance: A new, unique authorization code (`new_auth_code`) 
       is generated by the proxy.
    4. Code Persistence: This new code is stored (`AUTHORIZATION_CODES`), linking 
       it back to the original client's details and the captured upstream code/parameters.
    5. Final Redirection: The user agent is redirected to the MCP Client's original `redirect_uri` along with the newly generated `code` and the client's 
       original `state` parameter.

    Architectural Role: This endpoint is vital for decoupling the MCP Client 
    from the upstream flow. The `new_auth_code` serves as an access key that the 
    MCP Client will use in the subsequent `/token` exchange, allowing the proxy 
    to retrieve the stored upstream code and complete the flow.
    """
    logger.info(f"Received callback from upstream provider for transaction_id: {state}")
    transaction_id = state
    txn: AuthorizationTransaction = AUTH_TRANSACTIONS.get(transaction_id)
    

    if not txn:
        logger.error(f"Callback received with invalid or expired transaction_id: {transaction_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_state_or_transaction_expired")

    if ensure_aware_utc(txn.expires_at) < datetime.now(timezone.utc):
        logger.warning(f"Expired transaction in callback for transaction_id: {transaction_id}")
        AUTH_TRANSACTIONS.pop(transaction_id, None)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="transaction_expired")
        

    logger.debug(f"Storing upstream authorization code for transaction_id: {transaction_id}")
    # txn["upstream_code"] = code
    # txn["upstream_location"] = location
    # txn["upstream_accounts_server"] = accounts_server
    
    new_auth_code = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    
    AUTHORIZATION_CODES[new_auth_code] = AuthorizationCode(
        created_at=now,
        expires_at=now + timedelta(seconds=AUTH_CODE_TTL_SECONDS),
        transaction_id=transaction_id,
        client_id=txn.client_id,
        redirect_uri=txn.redirect_uri,
        code_challenge=txn.code_challenge,
        code_challenge_method=txn.code_challenge_method,
        upstream_location=location,
        upstream_code=code
    )
    logger.info(f"Generated proxy authorization code for client_id: {txn.client_id}")

    client_params = {
        "code": new_auth_code,
        "state": txn.state
    }
    
    final_redirect_url = build_url_with_params(txn.redirect_uri.__str__(), client_params)
    logger.debug(f"Redirecting to client callback URI for client_id: {txn.client_id}")
    return RedirectResponse(url=final_redirect_url, status_code=status.HTTP_302_FOUND)


def upstream_token_exchange(code: str) -> dict:
    """
    ## Upstream Token Exchange

    Performs the final token exchange with the Upstream OAuth Provider using 
    the statically registered client credentials.

    Functionality: This is a private helper function used internally by the 
    proxy's `/token` endpoint. It facilitates the exchange of the upstream 
authorization code (received during the `/auth/callback` step) for the 
    actual Access Token, Refresh Token, and ID Token from the upstream provider.
    """
    logger.info("Initiating upstream token exchange")
    
    proxy_callback_uri = urljoin(Settings.FASTMCP_SERVER_PUBLIC_URL.rstrip('/') + '/', "auth/callback")
    token_endpoint = urljoin(Settings.OIDC_PROVIDER_BASE_URL.rstrip('/') + '/', "oauth/v2/token")
    data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": proxy_callback_uri,
        "client_id": Settings.OIDC_PROVIDER_CLIENT_ID,
        "client_secret": Settings.OIDC_PROVIDER_CLIENT_SECRET
    }
    
    try:
        response = httpx.post(
            token_endpoint,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        response.raise_for_status()
        logger.info("Upstream token exchange successful")
        return response.json()
    except httpx.HTTPStatusError as e:
        logger.error(f"Upstream token exchange failed with status {e.response.status_code}", exc_info=True)
        raise
    except Exception as e:
        logger.error("Upstream token exchange failed with unexpected error", exc_info=True)
        raise


@authRouter.post("/token")
async def token_exchange(
    grant_type: str = Form(...),
    code: str = Form(...),
    redirect_uri: str = Form(...),
    client_id: str = Form(...),
    client_secret: str = Form(...)
    ):
    """
    ## OAuth 2.0 Token Exchange Endpoint (Final Step)

    This is the final step where the MCP Client exchanges its proxy-issued authorization code for 
    the upstream access and refresh tokens.

    Functionality: This endpoint performs comprehensive validation of the client and the code, 
    and then initiates the secure, backend-channel token exchange with the Upstream Provider. 

    This function completes the Indirection Layer. It is the last step where the proxy's 
    internal state (the authorization code linkage) is consumed, and the upstream tokens 
    are exposed to the authenticated MCP Client.
    """
    

    logger.info(f"Token exchange requested for client_id: {client_id}")
    
    if grant_type != "authorization_code":
        logger.warning(f"Unsupported grant type requested: {grant_type}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unsupported_grant_type")
        

    client_data : DynamicClientRegistrationRequest = REGISTERED_CLIENTS.get(client_id)
    if not client_data or client_data.secret != client_secret:
        logger.warning(f"Invalid client credentials for client_id: {client_id}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_client")


    auth_code_data = AUTHORIZATION_CODES.get(code)
    if not auth_code_data:
        logger.warning(f"Token exchange attempted with invalid authorization code for client_id: {client_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_grant")


    if auth_code_data.client_id != client_id or auth_code_data.redirect_uri.__str__() != redirect_uri:
        logger.warning(f"Authorization code mismatch for client_id: {client_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_grant")
    

    if ensure_aware_utc(auth_code_data.expires_at) < datetime.now(timezone.utc):
        logger.warning(f"Expired authorization code used for client_id: {client_id}")
        AUTHORIZATION_CODES.pop(code, None)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid_grant")
        
    
    upstream_code = auth_code_data.upstream_code

    try:
        upstream_tokens = upstream_token_exchange(
            code=upstream_code,
        )
   
    except Exception as e:
        logger.error(f"Upstream token exchange failed for client_id: {client_id}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="upstream_token_exchange_failed")
    
    response_tokens = {
        "access_token": upstream_tokens.get("access_token"),
        "token_type": upstream_tokens.get("token_type", "Bearer"),
        "expires_in": upstream_tokens.get("expires_in"),
        "refresh_token": upstream_tokens.get("refresh_token"),
        "scope": upstream_tokens.get("scope"),
        "id_token": upstream_tokens.get("id_token"),
    }
    logger.info(f"Token exchange completed successfully for client_id: {client_id}")
    return JSONResponse(content=response_tokens, status_code=status.HTTP_200_OK)
    
