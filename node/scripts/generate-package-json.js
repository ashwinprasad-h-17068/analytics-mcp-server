#!/usr/bin/env node
/**
 * Package.json Generator Script
 * 
 * This script generates package.json from package.template.json,
 * replacing placeholders with values derived from the PRODUCT_NAME environment variable.
 * 
 * Environment Variables:
 *   PRODUCT_NAME - The product name (default: "Zoho Analytics")
 * 
 * Placeholders in template:
 *   {{PACKAGE_NAME}} - The npm package name (e.g., "meap-mcp-server")
 *   {{BINARY_NAME}} - The binary executable name
 *   {{PACKAGE_DESCRIPTION}} - The package description
 */

const fs = require('fs');
const path = require('path');

// Read product name from environment variable
const PRODUCT_NAME = process.env.PRODUCT_NAME || "Zoho Analytics";
const PRODUCT_NAME_KEBAB = PRODUCT_NAME.toLowerCase().replace(/\s+/g, "-");
const PACKAGE_NAME = `${PRODUCT_NAME_KEBAB}-mcp-server`;
const BINARY_NAME = PACKAGE_NAME;
const PACKAGE_DESCRIPTION = `MCP server implementation for ${PRODUCT_NAME}`;

console.log(`\n📦 Generating package.json for ${PRODUCT_NAME}...`);

// Read template
const templatePath = path.join(__dirname, '..', 'package.template.json');
if (!fs.existsSync(templatePath)) {
  console.error(`❌ Error: Template file not found at ${templatePath}`);
  console.error(`   Please ensure package.template.json exists.`);
  process.exit(1);
}

let template;
try {
  template = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
  console.error(`❌ Error reading template file: ${err.message}`);
  process.exit(1);
}

// Replace placeholders
const packageJson = template
  .replace(/\{\{PACKAGE_NAME\}\}/g, PACKAGE_NAME)
  .replace(/\{\{BINARY_NAME\}\}/g, BINARY_NAME)
  .replace(/\{\{PACKAGE_DESCRIPTION\}\}/g, PACKAGE_DESCRIPTION);

// Validate that it's valid JSON
try {
  JSON.parse(packageJson);
} catch (err) {
  console.error(`❌ Error: Generated package.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

// Write to package.json
const outputPath = path.join(__dirname, '..', 'package.json');
try {
  fs.writeFileSync(outputPath, packageJson, 'utf8');
} catch (err) {
  console.error(`❌ Error writing package.json: ${err.message}`);
  process.exit(1);
}

console.log(`✅ Generated package.json successfully!`);
console.log(`   - Product name: ${PRODUCT_NAME}`);
console.log(`   - Package name: ${PACKAGE_NAME}`);
console.log(`   - Binary name: ${BINARY_NAME}`);
console.log(`   - Description: ${PACKAGE_DESCRIPTION}\n`);
