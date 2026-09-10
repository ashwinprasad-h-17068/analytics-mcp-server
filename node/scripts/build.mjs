#!/usr/bin/env node

/**
 * Build Script
 * 
 * This script:
 * 1. Runs TypeScript compilation (tsc)
 * 2. Replaces __PRODUCT_NAME__ placeholder in compiled JS files
 * 3. Uses PRODUCT_NAME environment variable or defaults to "Zoho Analytics"
 * 
 * Usage:
 *   npm run build              → "Zoho Analytics"
 *   npm run build:meap         → "MEAP"
 *   npm run build:zaop         → "ZAOP"
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get product name from environment or use default
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Zoho Analytics';
const PLACEHOLDER = '__PRODUCT_NAME__';

console.log(`\n🔧 Building with PRODUCT_NAME: "${PRODUCT_NAME}"\n`);

// Step 1: Build sql_limit_enforcer workspace
console.log('📦 Building sql_limit_enforcer workspace...');
try {
  execSync('npm run build --workspace=packages/sql_limit_enforcer', { 
    stdio: 'inherit',
    cwd: resolve(__dirname, '..')
  });
  console.log('✅ sql_limit_enforcer built successfully\n');
} catch (error) {
  console.error('❌ Failed to build sql_limit_enforcer workspace');
  process.exit(1);
}

// Step 2: Run TypeScript compiler
console.log('🔨 Running TypeScript compiler...');
try {
  execSync('tsc', { 
    stdio: 'inherit',
    cwd: resolve(__dirname, '..')
  });
  console.log('✅ TypeScript compilation successful\n');
} catch (error) {
  console.error('❌ TypeScript compilation failed');
  process.exit(1);
}

// Step 3: Replace placeholders in dist files
console.log('🔄 Replacing placeholders in compiled files...');

const distDir = resolve(__dirname, '..', 'dist');

/**
 * Replace placeholders in a file
 */
function replacePlaceholder(filePath) {
  try {
    let content = readFileSync(filePath, 'utf8');
    
    // Check if placeholder exists
    if (content.includes(PLACEHOLDER)) {
      // Replace all occurrences
      const updatedContent = content.replaceAll(PLACEHOLDER, PRODUCT_NAME);
      writeFileSync(filePath, updatedContent, 'utf8');
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`⚠️  Error processing ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Recursively walk directory and process JS files
 */
import { readdirSync, statSync } from 'fs';

function walkDirSync(dir) {
  const files = [];
  
  function traverse(currentPath) {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

let filesProcessed = 0;
let filesModified = 0;

try {
  const jsFiles = walkDirSync(distDir);
  
  for (const filePath of jsFiles) {
    filesProcessed++;
    const wasModified = replacePlaceholder(filePath);
    if (wasModified) {
      filesModified++;
      console.log(`  ✓ ${filePath.replace(distDir, 'dist')}`);
    }
  }
  
  console.log(`\n✅ Processed ${filesProcessed} JS files, modified ${filesModified} files\n`);
  console.log(`🎉 Build complete! Product: "${PRODUCT_NAME}"\n`);
} catch (error) {
  console.error('❌ Error during placeholder replacement:', error.message);
  process.exit(1);
}
