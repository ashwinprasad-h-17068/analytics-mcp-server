/**
 * Product Configuration Module
 * 
 * This module provides product-specific constants that can be configured at build time.
 * The placeholder __PRODUCT_NAME__ is replaced during the build process.
 * 
 * Usage:
 *   - Default: npm run build (uses "Zoho Analytics")
 *   - MEAP: npm run build:meap
 *   - ZAOP: npm run build:zaop
 */

// Build-time placeholder - replaced by scripts/build.mjs
export const PRODUCT_NAME = "__PRODUCT_NAME__";

// Generate kebab-case version for server name and binary
export const PRODUCT_NAME_KEBAB = PRODUCT_NAME
  .toLowerCase()
  .replace(/\s+/g, "-");

// Generate package name
export const PACKAGE_NAME = `${PRODUCT_NAME_KEBAB}-mcp-server`;
export const BINARY_NAME = PACKAGE_NAME;

// Description
export const PACKAGE_DESCRIPTION = `MCP server implementation for ${PRODUCT_NAME}`;

// Log configuration on module load (for debugging) - Uncomment when necessary
// if (process.env.DEBUG === 'true') {
//   console.error(`[Product Config] PRODUCT_NAME: ${PRODUCT_NAME}`);
//   console.error(`[Product Config] PACKAGE_NAME: ${PACKAGE_NAME}`);
// }
