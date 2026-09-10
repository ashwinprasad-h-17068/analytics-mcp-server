# Debugging Guide

This guide covers debugging the Node.js MCP server using VS Code, for both native and containerized development environments.

← [Documentation Index](./INDEX.md) | [Main Guide](./README.md)

## Contents

- [Prerequisites](#prerequisites)
- [Overview](#overview)
- [Debugging Methods](#debugging-methods)
  - [Method 1: Attach to Running Server](#method-1-attach-to-running-server-recommended)
- [Troubleshooting](#troubleshooting)
- [Disabling Debug Mode](#disabling-debug-mode)
- [Security Warning](#security-warning)
- [Launch Configuration Reference](#launch-configuration-reference)

## Prerequisites

- VS Code installed
- Project built (`npm run build`)
- Environment variables configured (see [Environment Setup](./ENVIRONMENT_SETUP.md))
- For containerized development, container must be running

## Overview

The Node.js MCP server supports debugging via Node.js Inspector. You can:
- **Attach to a running server** (recommended for production-like debugging)
- **Launch directly from VS Code** (for quick testing)

Both methods work in native and containerized environments.

## Debugging Methods

### Attach to Running Server

This method debugs the server in its normal runtime environment, including when running with MCP clients.

#### Step 1: Enable Debugging in Code

1. Open `node/src/index.ts`
2. **Uncomment** the debugging block at the top (lines with `import inspector` and `if (process.env.DEBUG === 'true')`)
3. Rebuild: `npm run build`

#### Step 2: Start Server with Debug Mode

**Native Development:**
```bash
DEBUG=true DEBUG_PORT=9229 node dist/src/index.js
```

**Containerized Development:**
```bash
# Inside the container
DEBUG=true DEBUG_PORT=9229 node dist/src/index.js
```

**With MCP Client (e.g., Claude Desktop):**
Add to your MCP configuration:
```json
{
  "mcpServers": {
    "zoho-analytics": {
      "command": "node",
      "args": ["/path/to/dist/src/index.js"],
      "env": {
        "DEBUG": "true",
        "DEBUG_PORT": "9229"
        // ... other environment variables
      }
    }
  }
}
```

#### Step 3: Attach VS Code Debugger

1. Open project in VS Code
2. Debug panel (Ctrl+Shift+D / Cmd+Shift+D)
3. Select **"Attach to MCP Server"** from dropdown
4. Click green play button (F5)
5. Set breakpoints and debug

**For Containerized Development:** Since `network_mode: host` is used, the debug port (9229) is accessible on your host machine. The attach process is identical to native development.


## Troubleshooting

### Debugger Won't Attach

**Symptoms:** VS Code can't connect to debugger

**Solutions:**
1. Verify server is running with `DEBUG=true`
2. Check console for "Debugger listening on..." message
3. Ensure `DEBUG_PORT` matches port in launch.json (default: 9229)
4. Check no other process is using the debug port:
   ```bash
   # Check if port is in use
   lsof -i :9229
   ```
5. **For containerized development**: Verify container is using `network_mode: host`

### Breakpoints Not Hit

**Symptoms:** Red breakpoints show as gray circles or don't pause execution

**Solutions:**
1. Verify source maps are enabled in `node/tsconfig.json` (should be already)
2. Rebuild project: `npm run build`
3. Check breakpoint is in code path that executes
4. Verify correct source files are loaded
5. Try clean rebuild:
   ```bash
   rm -rf dist && npm run build
   ```

### Source Maps Not Working

**Symptoms:** Debugger doesn't map back to TypeScript source

**Solutions:**
1. Verify `sourceMap: true` in `node/tsconfig.json`
2. Clean rebuild: `rm -rf dist && npm run build`
3. Check `.map` files exist in `dist` directory
4. Ensure `outDir` in `tsconfig.json` matches your build output

### Port Already in Use

**Symptoms:** Error about port 9229 already in use

**Solutions:**
1. Change port:
   ```bash
   DEBUG_PORT=9230 node dist/src/index.js
   ```
2. Update `launch.json` to match new port
3. Kill process using the port:
   ```bash
   # Find process
   lsof -i :9229
   # Kill process
   kill -9 <PID>
   ```

### Container-Specific Issues

**Can't attach debugger to containerized server:**

1. Verify `network_mode: host` in `docker-compose.node_dev_env.yaml`
2. Check server is running inside container:
   ```bash
   docker exec -it analytics-mcp-node-dev ps aux | grep node
   ```
3. Verify environment variables are loaded:
   ```bash
   docker exec -it analytics-mcp-node-dev bash -c 'echo $DEBUG'
   ```

## Disabling Debug Mode

To disable debugging:

**Option 1:** Remove environment variable
```bash
# Just don't set DEBUG=true
node dist/src/index.js
```

**Option 2:** Comment out debugging code
1. Comment out debugging block in `node/src/index.ts`
2. Rebuild: `npm run build`

## Security Warning

⚠️ **Never enable debugging in production environments.**

The debug port provides full access to the Node.js process, including:
- Reading all variables and memory
- Executing arbitrary code
- Modifying application behavior

Only use debugging in secure development environments.

## Launch Configuration Reference

The project includes VS Code launch configurations in `.vscode/launch.json`:

**"Attach to MCP Server"**: Attaches to running server on port 9229
- Use this for debugging with MCP clients or containerized environments
- Server must be started with `DEBUG=true`

**"Debug MCP Server (Direct Launch)"**: Launches server directly from VS Code
- Use for quick testing without MCP client
- Loads environment variables from `node/.env`

## Related Documentation

- [Development Setup](./DEVELOPMENT_SETUP.md) - Choose your development environment
- [Environment Setup](./ENVIRONMENT_SETUP.md) - Configure environment variables
- [Containerized Development](./CONTAINERIZED_DEVELOPMENT.md) - Docker-based debugging

## Additional Resources

- [VS Code Debugging Documentation](https://code.visualstudio.com/docs/editor/debugging)
- [Node.js Debugging Guide](https://nodejs.org/en/docs/guides/debugging-getting-started/)
- [Node.js Inspector API](https://nodejs.org/api/inspector.html)
- [VS Code Remote Development](https://code.visualstudio.com/docs/remote/remote-overview)

---

← [Documentation Index](./INDEX.md) | [Main Guide](./README.md)
