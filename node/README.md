# Zoho Analytics MCP Server

[![NPM Version](https://img.shields.io/npm/v/zoho-analytics-mcp-server)](https://www.npmjs.com/package/zoho-analytics-mcp-server)
[![NPM Downloads](https://img.shields.io/npm/dm/zoho-analytics-mcp-server)](https://www.npmjs.com/package/zoho-analytics-mcp-server)

A Node.js implementation of the Zoho Analytics Model Context Protocol (MCP) Server that provides seamless integration between Zoho Analytics and MCP Hosts such as VS Code, Claude Desktop, Cursor, and more.

## Overview

The Zoho Analytics MCP Server enables direct access to your Zoho Analytics data through MCP-compatible applications. This NPM package provides a lightweight, Docker-free alternative that makes it easy to integrate Zoho Analytics into your MCP workflows.

**Key Benefits:**
- Direct access to Zoho Analytics data from MCP-compatible applications
- No Docker dependency - runs directly with Node.js
- Easy configuration through environment variables
- Support for multiple MCP hosts

## Prerequisites

Before using the Zoho Analytics MCP Server, ensure you have:

- **Node.js** - Latest LTS version recommended
- **MCP Host Application** - Such as VS Code with GitHub Copilot extension, Claude Desktop, or Cursor
- **Zoho Account Credentials** - Client ID, Client Secret, and Refresh Token (see [Authentication Setup](#authentication-setup))

## Quick Start

### Installation

The easiest way to use the Zoho Analytics MCP Server is through NPX (no installation required):

```bash
npx zoho-analytics-mcp-server@latest
```

Alternatively, you can install it globally:

```bash
npm install -g zoho-analytics-mcp-server
```

### Authentication Setup

To use the Zoho Analytics MCP Server, you need OAuth credentials from Zoho. Follow these steps:

1. **Go to the [Zoho Developer Console](https://api-console.zoho.com/)**
2. **Create a new Self-Client application**
3. **Enable the Zoho Analytics API scope**
4. **Generate your Refresh Token**

For detailed instructions, refer to the [official API Authentication Documentation](https://www.zoho.com/analytics/api/).

## Configuration

### Environment Variables

#### Required Variables

| Variable | Description |
|----------|-------------|
| `ANALYTICS_CLIENT_ID` | Your Zoho Analytics OAuth client ID |
| `ANALYTICS_CLIENT_SECRET` | Your Zoho Analytics OAuth client secret |
| `ANALYTICS_REFRESH_TOKEN` | Your Zoho Analytics OAuth refresh token |
| `ANALYTICS_ORG_ID` | Your Zoho Analytics organization ID |
| `ACCOUNTS_SERVER_URL` | Your Zoho Accounts Domain URL (typically `https://accounts.zoho.com`) |
| `ANALYTICS_SERVER_URL` | Your Zoho Analytics API Domain URL (typically `https://analyticsapi.zoho.com`) |

#### Optional Variables

| Variable | Description | Default Value |
|----------|-------------|---------------|
| `ANALYTICS_MCP_DATA_DIR` | Directory for storing temporary data files | System temp directory |
| `QUERY_DATA_RESULT_ROW_LIMITS` | Maximum number of rows returned by the query_data tool | 20 |
| `QUERY_DATA_POLLING_INTERVAL` | Interval (in seconds) between job status polls | 4 |
| `QUERY_DATA_QUEUE_TIMEOUT` | Maximum time (in seconds) a job can remain in queue | 120 |
| `QUERY_DATA_QUERY_EXECUTION_TIMEOUT` | Maximum query execution time (in seconds) | 30 |
| `WORKSPACE_RESULT_LIMIT` | Maximum number of workspaces returned by get_workspaces | 20 |
| `VIEW_RESULT_LIMIT` | Maximum number of views returned by get_views | 30 |

## MCP Host Integration

### VS Code Configuration

Add the following configuration to your VS Code MCP settings file. For detailed setup instructions, see the [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

```json
{
  "servers": {
    "zoho_analytics": {
      "type": "stdio",
      "command": "npx",
      "args": ["zoho-analytics-mcp-server@latest"],
      "env": {
        "ANALYTICS_CLIENT_ID": "your-client-id-here",
        "ANALYTICS_CLIENT_SECRET": "your-client-secret-here", 
        "ANALYTICS_REFRESH_TOKEN": "your-refresh-token-here",
        "ANALYTICS_ORG_ID": "your-org-id-here",
        "ACCOUNTS_SERVER_URL": "https://accounts.zoho.com",
        "ANALYTICS_SERVER_URL": "https://analyticsapi.zoho.com"
      }
    }
  }
}
```

### Claude Desktop Configuration

For Claude Desktop, add the following to your MCP configuration file:

```json
{
  "mcpServers": {
    "zoho-analytics-mcp": {
      "command": "npx",
      "args": ["zoho-analytics-mcp-server@latest"],
      "env": {
        "ANALYTICS_CLIENT_ID": "your-client-id-here",
        "ANALYTICS_CLIENT_SECRET": "your-client-secret-here",
        "ANALYTICS_REFRESH_TOKEN": "your-refresh-token-here", 
        "ANALYTICS_ORG_ID": "your-org-id-here",
        "ACCOUNTS_SERVER_URL": "https://accounts.zoho.com",
        "ANALYTICS_SERVER_URL": "https://analyticsapi.zoho.com"
      }
    }
  }
}
```

## Building from Source

If you want to build the MCP server from source or need to use a local development version:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/zoho/analytics-mcp-server
   cd analytics-mcp-server
   ```

2. **Install dependencies:**
   ```bash
   cd node
   npm install
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

### Using Local Build

To use your local build with an MCP host:

```json
{
  "servers": {
    "zoho_analytics_local": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute-path-to-zoho-analytics-mcp-server/node/dist/index.js"],
      "env": {
        "ANALYTICS_CLIENT_ID": "your-client-id",
        "ANALYTICS_CLIENT_SECRET": "your-client-secret",
        "ANALYTICS_REFRESH_TOKEN": "your-refresh-token",
        "ANALYTICS_ORG_ID": "your-org-id",
        "ACCOUNTS_SERVER_URL": "https://accounts.zoho.com",
        "ANALYTICS_SERVER_URL": "https://analyticsapi.zoho.com"
      }
    }
  }
}
```

## Troubleshooting

### Common Issues

- **Authentication Errors**: Ensure your OAuth credentials are correct and have the necessary scopes
- **Connection Timeouts**: Check your network connectivity and adjust timeout values if necessary
- **Permission Errors**: Verify that your Zoho account has access to the specified organization and workspaces

### Support

For issues and questions, contact Zoho support for account-related issues