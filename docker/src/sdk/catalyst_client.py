import json
import urllib.parse
import requests
from typing import Optional, Dict, Any


class AuthConfig:
    """Simple class to hold authentication credentials."""
    
    def __init__(self, client_id: str, client_secret: str, refresh_token: str, access_token: str = ""):
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.access_token = access_token
    
    def set_access_token(self, token: str):
        """Update the access token."""
        self.access_token = token


class ServerError(Exception):
    """Exception raised for server errors."""
    
    def __init__(self, message: str, is_oauth_error: bool = False):
        self.message = message
        self.is_oauth_error = is_oauth_error
        super().__init__(self.message)


class ResponseObject:
    """Wrapper for HTTP response."""
    
    def __init__(self, status_code: int, resp_content: str):
        self.status_code = status_code
        self.resp_content = resp_content


class CatalystCache:
    """
    Sync Python wrapper for Catalyst Cache operations.
    
    Provides synchronous methods to insert, get, update, and delete cache key-value pairs
    in Catalyst Cache segments with automatic OAuth token refresh.
    """
    
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        project_id: str,
        segment_id: str,
        api_domain: str = "https://api.catalyst.zoho.com",
        accounts_server_url: str = "https://accounts.zoho.com",
        access_token: str = ""
    ):
        """
        Initialize the CatalystCache client.
        
        Args:
            client_id: OAuth client ID
            client_secret: OAuth client secret
            refresh_token: OAuth refresh token
            project_id: Catalyst project ID
            segment_id: Cache segment ID
            api_domain: API domain URL (default: https://api.catalyst.zoho.com)
            accounts_server_url: Accounts server URL for OAuth (default: https://accounts.zoho.com)
            access_token: Initial access token (optional, will be generated if not provided)
        """
        self.auth = AuthConfig(client_id, client_secret, refresh_token, access_token)
        self.project_id = project_id
        self.segment_id = segment_id
        self.api_domain = api_domain.rstrip('/')
        self.accounts_server_url = accounts_server_url.rstrip('/')
        self.base_url = f"{self.api_domain}/baas/v1/project/{self.project_id}/segment/{self.segment_id}/cache"
        self._session: Optional[requests.Session] = None
    
    def __enter__(self):
        """Context manager entry."""
        self._ensure_session()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
    
    def _ensure_session(self):
        """Ensure a requests session exists."""
        if self._session is None:
            self._session = requests.Session()
    
    def close(self):
        """Close the requests session."""
        if self._session:
            self._session.close()
            self._session = None
    
    def _get_headers(self, content_type: Optional[str] = None) -> Dict[str, str]:
        """Get HTTP headers with OAuth token."""
        headers = {
            "Authorization": f"Zoho-oauthtoken {self.auth.access_token}"
        }
        if content_type:
            headers["Content-Type"] = content_type
        return headers
    
    def submit_request(self, method: str, url: str, data: Any = None, params: Dict = None) -> ResponseObject:
        """
        Submit an HTTP request.
        
        Args:
            method: HTTP method (GET, POST, PUT, DELETE)
            url: Request URL
            data: Request data/body
            params: Query parameters
        
        Returns:
            ResponseObject containing status code and content
        
        Raises:
            ServerError: If request fails
        """
        self._ensure_session()
        
        try:
            if method == "POST" and isinstance(data, str):
                # For OAuth token request with URL-encoded data
                headers = {"Content-Type": "application/x-www-form-urlencoded"}
                response = self._session.post(url, data=data, headers=headers)
                return ResponseObject(response.status_code, response.text)
            else:
                headers = self._get_headers("application/json" if data and method in ["POST", "PUT"] else None)
                
                if method == "GET":
                    response = self._session.get(url, headers=headers, params=params)
                elif method == "POST":
                    response = self._session.post(url, headers=headers, json=data)
                elif method == "PUT":
                    response = self._session.put(url, headers=headers, json=data)
                elif method == "DELETE":
                    response = self._session.delete(url, headers=headers, params=params)
                else:
                    raise ValueError(f"Unsupported HTTP method: {method}")
                
                return ResponseObject(response.status_code, response.text)
        
        except requests.RequestException as e:
            raise ServerError(str(e))
    
    def is_oauth_expired(self, resp_obj: ResponseObject) -> bool:
        """
        Check whether the access token has expired.
        
        Args:
            resp_obj: Response object from API call
        
        Returns:
            True if OAuth token expired, False otherwise
        """
        try:
            resp_content = json.loads(resp_obj.resp_content)
            err_code = resp_content["data"]["error_code"]
            return err_code == "AUTHENTICATION_FAILURE" # NEED TO VERIFY I18N
        except Exception:
            return False
    
    def regenerate_analytics_oauth_token(self):
        """
        Refresh the OAuth access token using the refresh token.
        
        Raises:
            ServerError: If token refresh fails
        """
        oauth_params = {
            "client_id": self.auth.client_id,
            "client_secret": self.auth.client_secret,
            "refresh_token": self.auth.refresh_token,
            "grant_type": "refresh_token"
        }
        oauth_params = urllib.parse.urlencode(oauth_params)
        req_url = f"{self.accounts_server_url}/oauth/v2/token"
        oauth_resp_obj = self.submit_request("POST", req_url, oauth_params)
        
        if oauth_resp_obj.status_code == 200:
            oauth_json_resp = json.loads(oauth_resp_obj.resp_content)
            if "access_token" in oauth_json_resp:
                self.auth.set_access_token(oauth_json_resp["access_token"])
                return
        
        raise ServerError(oauth_resp_obj.resp_content, True)
    
    def _execute_with_retry(self, method: str, url: str, data: Any = None, params: Dict = None) -> ResponseObject:
        """
        Execute request with automatic token refresh and retry on OAuth expiry.
        
        Args:
            method: HTTP method
            url: Request URL
            data: Request data/body
            params: Query parameters
        
        Returns:
            ResponseObject from successful request
        
        Raises:
            ServerError: If request fails after retry
        """
        resp_obj = self.submit_request(method, url, data, params)
        
        # Check if token expired and retry once
        if not str(resp_obj.status_code).startswith('2') and self.is_oauth_expired(resp_obj):
            self.regenerate_analytics_oauth_token()
            resp_obj = self.submit_request(method, url, data, params)
        
        return resp_obj
    
    def insert(self, cache_name: str, cache_value: str, expiry_in_hours: Optional[int] = None) -> Dict[str, Any]:
        """
        Insert a key-value pair in the cache segment.
        
        Args:
            cache_name: Name/key of the cache item
            cache_value: Value to store
            expiry_in_hours: Expiry time in hours (optional)
        
        Returns:
            API response as dictionary
        
        Raises:
            ServerError: If request fails
        """
        payload = {
            "cache_name": cache_name,
            "cache_value": cache_value
        }
        
        if expiry_in_hours is not None:
            payload["expiry_in_hours"] = expiry_in_hours
        
        resp_obj = self._execute_with_retry("POST", self.base_url, payload)
        
        if str(resp_obj.status_code).startswith('2'):
            return json.loads(resp_obj.resp_content)
        else:
            raise ServerError(f"Failed to insert cache: {resp_obj.resp_content}")
    
    def get(self, cache_key: str) -> Dict[str, Any]:
        """
        Get the value of a cache key.
        
        Args:
            cache_key: Key of the cache item to retrieve
        
        Returns:
            API response as dictionary containing the cache value
        
        Raises:
            ServerError: If request fails
        """
        params = {"cacheKey": cache_key}
        resp_obj = self._execute_with_retry("GET", self.base_url, params=params)
        
        if str(resp_obj.status_code).startswith('2'):
            return json.loads(resp_obj.resp_content)
        else:
            raise ServerError(f"Failed to get cache: {resp_obj.resp_content}")
    
    def update(self, cache_name: str, cache_value: str) -> Dict[str, Any]:
        """
        Update the value of an existing cache key.
        
        Args:
            cache_name: Name/key of the cache item to update
            cache_value: New value
        
        Returns:
            API response as dictionary
        
        Raises:
            ServerError: If request fails
        """
        payload = {
            "cache_name": cache_name,
            "cache_value": cache_value
        }
        
        resp_obj = self._execute_with_retry("PUT", self.base_url, payload)
        
        if str(resp_obj.status_code).startswith('2'):
            return json.loads(resp_obj.resp_content)
        else:
            raise ServerError(f"Failed to update cache: {resp_obj.resp_content}")
    
    def delete(self, cache_key: str) -> Dict[str, Any]:
        """
        Delete a cache key from the segment.
        
        Args:
            cache_key: Key of the cache item to delete
        
        Returns:
            API response as dictionary
        
        Raises:
            ServerError: If request fails
        """
        params = {"cacheKey": cache_key}
        resp_obj = self._execute_with_retry("DELETE", self.base_url, params=params)
        
        if str(resp_obj.status_code).startswith('2'):
            return json.loads(resp_obj.resp_content)
        else:
            raise ServerError(f"Failed to delete cache: {resp_obj.resp_content}")