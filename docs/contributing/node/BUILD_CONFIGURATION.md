# Build Configuration

This guide explains how to configure and build different variants of the Analytics MCP Server with customized product names and build settings.

← [Documentation Index](./INDEX.md) | [Main Guide](./README.md)

## Table of Contents

- [Product Variants](#product-variants)
- [Build Process](#build-process)
- [Configuration Options](#configuration-options)
- [Advanced Usage](#advanced-usage)
- [Troubleshooting](#troubleshooting)

## Product Variants

The Analytics MCP Server supports building multiple product variants from the same codebase. Each variant can have a different product name that appears throughout the application.

### What Changes Between Variants

When you build a variant with a custom product name, the following are automatically updated:

- **Package name** in `package.json`
- **Binary execution name** used in CLI
- **Tool descriptions** shown to users
- **Server name** in the MCP protocol
- **Console messages** during runtime

All variants share the same version number for consistency.

### Default Build (Zoho Analytics)

If no `PRODUCT_NAME` is specified, the default product name is **"Zoho Analytics"**.

```bash
cd node
npm run build
```

**Output:**
- Package name: `zoho-analytics-mcp-server`
- Binary name: `zoho-analytics-mcp-server`
- Server name: `zoho-analytics`

### Building Named Variants

For convenience, the project includes npm script shortcuts for common variants:

#### MEAP Variant

```bash
cd node
npm run build:meap
```

Equivalent to: `PRODUCT_NAME=MEAP npm run build`

**Output:**
- Package name: `meap-mcp-server`
- Binary name: `meap-mcp-server`
- Server name: `meap`

#### ZAOP Variant

```bash
cd node
npm run build:zaop
```

Equivalent to: `PRODUCT_NAME=ZAOP npm run build`

**Output:**
- Package name: `zaop-mcp-server`
- Binary name: `zaop-mcp-server`
- Server name: `zaop`

#### Custom Variant

You can use any product name with spaces or special characters:

```bash
cd node
PRODUCT_NAME="My Analytics Product" npm run build
```

**Output:**
- Package name: `my-analytics-product-mcp-server`
- Binary name: `my-analytics-product-mcp-server`
- Server name: `my-analytics-product`

> **Note:** Product names with spaces are automatically converted to kebab-case for package and binary names.

## Build Process

### How Product Variants Work

The build system uses a **build-time placeholder substitution** approach with three steps:

#### Step 1: Pre-build Script

Before TypeScript compilation, `node/scripts/generate-package-json.js` executes:

1. Reads the `PRODUCT_NAME` environment variable
2. Loads `node/package.template.json` (the template file)
3. Replaces placeholders like `{{PACKAGE_NAME}}` and `{{BINARY_NAME}}`
4. Generates the final `node/package.json`

#### Step 2: TypeScript Compilation & Workspace Build

The main build script `node/scripts/build.mjs` orchestrates the compilation:

1. **Builds sql_limit_enforcer workspace** - Compiles the SQL limit enforcer package
2. **Runs TypeScript compiler (`tsc`)** - Compiles all TypeScript files to JavaScript in `dist/`
   - The placeholder `__PRODUCT_NAME__` is compiled as-is into the output
3. **Replaces placeholders in dist/** - Walks through all `dist/**/*.js` files and replaces `__PRODUCT_NAME__` with the actual product name from `process.env.PRODUCT_NAME`

#### Step 3: Build Output

The `dist/` directory contains the compiled code with the product name **permanently burned in**. Customers can run `node dist/src/index.js` directly with no environment variables needed.

### Why Build-Time Substitution?

**The Problem:** Runtime environment variables (`process.env.PRODUCT_NAME`) don't work because:
1. Customers run `node dist/src/index.js` directly
2. They won't set environment variables themselves
3. The MCP protocol doesn't provide a mechanism to pass environment variables

**The Solution:** Build-time substitution ensures:
1. TypeScript compiles the placeholder as-is: `"__PRODUCT_NAME__"`
2. Post-build script replaces all occurrences with the actual product name
3. Published artifact contains the literal string
4. No runtime configuration needed

### Configuration Module

The product configuration is centralized in `node/src/config/product.ts`:

```typescript
// Build-time placeholder - replaced by scripts/build.mjs
export const PRODUCT_NAME = "__PRODUCT_NAME__";

// Convert to kebab-case for package/binary names
export const PRODUCT_NAME_KEBAB = PRODUCT_NAME.toLowerCase().replace(/\s+/g, "-");

// Derive package and binary names
export const PACKAGE_NAME = `${PRODUCT_NAME_KEBAB}-mcp-server`;
export const BINARY_NAME = PACKAGE_NAME;

// Package description for package.json
export const PACKAGE_DESCRIPTION = `MCP server implementation for ${PRODUCT_NAME}`;
```

After the build process, `dist/src/config/product.js` will contain the actual product name:

```javascript
// Example after building with PRODUCT_NAME=MEAP
exports.PRODUCT_NAME = "MEAP";
```

All other modules import these constants to ensure consistency.

### Where Product Name Appears

#### Tool Descriptions

```typescript
import { PRODUCT_NAME } from "../config/product";

server.registerTool("getData", {
  description: `Use this to retrieve data from ${PRODUCT_NAME} using custom SQL queries`,
  // ...
});
```

#### Server Initialization

```typescript
import { PRODUCT_NAME, PRODUCT_NAME_KEBAB } from "./config/product";

const server = new Server({
  name: PRODUCT_NAME_KEBAB,
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});

console.error(`${PRODUCT_NAME} MCP server running on stdio`);
```

#### Health Check Tool

```typescript
server.registerTool('checkConnection', {
  description: `This tool performs a comprehensive health check of the ${PRODUCT_NAME} MCP Server.`,
  // ...
});
```

## Configuration Options

### Important Files

| File | Purpose | Edit? |
|------|---------|-------|
| `node/package.template.json` | Template for package.json with placeholders | ✅ Yes |
| `node/package.json` | Auto-generated package.json | ❌ No - regenerated on each build |
| `node/src/config/product.ts` | Product configuration logic | ✅ Yes (if changing logic) |
| `node/scripts/generate-package-json.js` | Pre-build script | ✅ Yes (if changing generation logic) |

### Environment Variables

| Variable | Purpose | When Set | Required |
|----------|---------|----------|----------|
| `PRODUCT_NAME` | Product variant name | Build time | No (defaults to "Zoho Analytics") |

### File Structure

```
node/
├── src/
│   ├── config/
│   │   └── product.ts              # Product configuration module
│   ├── index.ts                    # Main entry (uses PRODUCT_NAME_KEBAB)
│   └── tools/
│       ├── data-tools.ts           # Uses PRODUCT_NAME in tool descriptions
│       ├── metadata-tools.ts       # Uses PRODUCT_NAME in tool descriptions
│       ├── modelling-tools.ts      # Uses PRODUCT_NAME in tool descriptions
│       └── row-tools.ts            # May use PRODUCT_NAME if needed
├── scripts/
│   └── generate-package-json.js    # Pre-build script
├── package.template.json           # Template with {{PLACEHOLDERS}}
└── package.json                    # Auto-generated (DO NOT EDIT)
```

## Advanced Usage

### Development Workflow

```bash
cd node

# Build default variant for testing
npm run build
node dist/src/index.js

# Test MEAP variant
rm -rf dist/
PRODUCT_NAME=MEAP npm run build
node dist/src/index.js

# Test ZAOP variant
rm -rf dist/
PRODUCT_NAME=ZAOP npm run build
node dist/src/index.js

# Test custom variant
rm -rf dist/
PRODUCT_NAME="Custom Analytics" npm run build
node dist/src/index.js
```

### CI/CD Pipeline Example

Here's a GitHub Actions workflow that builds all variants:

```yaml
name: Build Variants

on: [push, pull_request]

jobs:
  build-variants:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        variant:
          - name: "Zoho Analytics"
            env: ""
          - name: "MEAP"
            env: "MEAP"
          - name: "ZAOP"
            env: "ZAOP"
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        working-directory: ./node
        run: npm install
      
      - name: Build ${{ matrix.variant.name }}
        working-directory: ./node
        run: |
          if [ -n "${{ matrix.variant.env }}" ]; then
            PRODUCT_NAME=${{ matrix.variant.env }} npm run build
          else
            npm run build
          fi
      
      - name: Archive build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.variant.name }}-build
          path: node/dist/
```

### Package Publishing

Each variant should be published as a separate npm package:

```bash
# Build and publish Zoho Analytics variant
cd node
npm run build
npm publish

# Build and publish MEAP variant
cd node
rm -rf dist/
PRODUCT_NAME=MEAP npm run build
npm publish

# Build and publish ZAOP variant
cd node
rm -rf dist/
PRODUCT_NAME=ZAOP npm run build
npm publish
```

> **Important:** Ensure the version number in `package.template.json` is updated before publishing any variant.

## Troubleshooting

### Issue: Package name doesn't change after setting `PRODUCT_NAME`

**Cause:** The pre-build script didn't run, or you're running `tsc` directly instead of `npm run build`.

**Solution:**
```bash
# Ensure you use npm run build (not tsc directly)
cd node
PRODUCT_NAME=MEAP npm run build

# Check that package.json was regenerated
cat package.json | grep '"name"'
```

---

### Issue: Tool descriptions still show old product name

**Cause:** TypeScript files weren't recompiled with the new environment variable, or old build artifacts remain.

**Solution:**
```bash
# Clean build from scratch
cd node
rm -rf dist/
PRODUCT_NAME=NewName npm run build

# Verify the output
node dist/src/index.js
```

---

### Issue: Binary name in package.json doesn't match expectations

**Cause:** The placeholder syntax in `package.template.json` is incorrect.

**Solution:**
```bash
# Check package.template.json for correct placeholders
cd node
grep "{{BINARY_NAME}}" package.template.json

# Expected format:
# "bin": {
#   "{{BINARY_NAME}}": "./dist/src/index.js"
# }
```

---

### Issue: Environment variable not being read during build

**Cause:** The environment variable isn't being passed to the Node.js process.

**Solution:**
```bash
# On Unix/Linux/macOS (inline variable)
PRODUCT_NAME=MEAP npm run build

# On Windows Command Prompt
set PRODUCT_NAME=MEAP && npm run build

# On Windows PowerShell
$env:PRODUCT_NAME="MEAP"; npm run build
```

---

### Issue: Build works but server crashes at runtime

**Cause:** Runtime dependencies might be missing, or the build didn't complete successfully.

**Solution:**
```bash
# Verify all dependencies are installed
cd node
npm install

# Rebuild from scratch
rm -rf dist/ node_modules/
npm install
PRODUCT_NAME=MEAP npm run build

# Check for TypeScript errors
npm run build 2>&1 | grep error
```

## Best Practices

1. **Always use `npm run build`** instead of calling `tsc` directly to ensure the pre-build script runs.

2. **Clean build artifacts** when switching between variants:
   ```bash
   rm -rf dist/
   ```

3. **Use version control** for `package.template.json`, not `package.json`.

4. **Document your variants** in project documentation if you maintain multiple variants.

5. **Test each variant** independently before publishing to npm.

6. **Use consistent naming** across all variants for easier maintenance.

## Related Documentation

- [Development Setup](./DEVELOPMENT_SETUP.md) - General development environment setup
- [Environment Setup](./ENVIRONMENT_SETUP.md) - Configuring credentials and environment variables
- [Debugging Guide](./DEBUGGING.md) - Debugging the MCP server

---

**Need help?** Refer back to the [main README](./README.md) for navigation and support resources.

---

← [Documentation Index](./INDEX.md) | [Main Guide](./README.md)
