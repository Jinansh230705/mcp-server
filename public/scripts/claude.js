#!/usr/bin/env node
/**
 * Materio MCP — Claude Desktop Integration Setup
 * 
 * Automatically detects your Claude Desktop configuration
 * and integrates the Materio MCP server via remote bridge.
 * 
 * © 2024-2026, Materio by JTC.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SERVER_NAME = "materio";
const REMOTE_URL = "https://materiomcp.vercel.app/mcp";
const ANIMATION_SPEED = 50;

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[0f');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeOut(text, speed = ANIMATION_SPEED) {
  for (const char of text) {
    process.stdout.write(char);
    await sleep(speed);
  }
}

async function printHeader() {
  clearScreen();
  console.log(`${colors.cyan}${colors.bright}`);
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                  MATERIO MCP SETUP UTILITY                      ║');
  console.log('║              Claude Desktop Integration v1.0                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);
  await sleep(400);
}

async function printStatus(message, type = 'info') {
  let prefix;
  let color;
  
  switch (type) {
    case 'success':
      prefix = '[OK]';
      color = colors.green;
      break;
    case 'error':
      prefix = '[ERROR]';
      color = colors.red;
      break;
    case 'warning':
      prefix = '[WARN]';
      color = colors.yellow;
      break;
    case 'info':
    default:
      prefix = '[INFO]';
      color = colors.cyan;
  }
  
  console.log(`${color}${prefix}${colors.reset} ${message}`);
}

async function printProgress(current, total, label) {
  const barLength = 40;
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * barLength);
  
  const bar = '[' + '='.repeat(filled) + ' '.repeat(barLength - filled) + ']';
  process.stdout.write(`\r${colors.cyan}${bar}${colors.reset} ${percentage}% - ${label}`);
  
  if (current === total) {
    process.stdout.write('\n');
  }
}

async function setup() {
  await printHeader();
  
  console.log(`${colors.bright}Initializing setup...${colors.reset}\n`);
  await sleep(300);
  
  // Step 1: Detect OS and Config Path
  await printProgress(0, 4, 'Detecting system configuration');
  await sleep(200);
  
  let configPath;
  let platformName;
  
  if (os.platform() === 'win32') {
    platformName = 'Windows';
    configPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Claude',
      'claude_desktop_config.json'
    );
  } else if (os.platform() === 'darwin') {
    platformName = 'macOS';
    configPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  } else {
    await printProgress(4, 4, 'System detection');
    console.log();
    await printStatus(
      `Unsupported operating system: ${os.platform()}`,
      'error'
    );
    console.log(
      `${colors.gray}Supported platforms: Windows, macOS${colors.reset}\n`
    );
    process.exit(1);
  }
  
  await printProgress(1, 4, `Platform detected: ${platformName}`);
  await sleep(300);
  
  // Step 2: Load or Create Configuration
  await printProgress(1.5, 4, 'Loading configuration');
  let config = { mcpServers: {} };
  let isNew = false;
  
  if (fs.existsSync(configPath)) {
    try {
      const data = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(data || '{}');
      if (!config.mcpServers) config.mcpServers = {};
      await printStatus('Configuration file found and parsed', 'info');
    } catch (e) {
      await printStatus(
        'Could not parse existing config; starting fresh',
        'warning'
      );
      config = { mcpServers: {} };
    }
  } else {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    isNew = true;
    await printStatus('New configuration will be created', 'info');
  }
  
  await sleep(300);
  await printProgress(2, 4, 'Configuration loaded');
  await sleep(300);
  
  // Step 3: Update Configuration
  await printProgress(2.5, 4, 'Registering Materio MCP server');
  
  config.mcpServers[SERVER_NAME] = {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      REMOTE_URL
    ]
  };
  
  await sleep(200);
  await printProgress(3, 4, 'Configuration updated');
  await sleep(300);
  
  // Step 4: Save Configuration
  await printProgress(3.5, 4, 'Writing configuration to disk');
  
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify(config, null, 2),
      'utf8'
    );
    await printProgress(4, 4, 'Setup complete');
    console.log();
    
    await sleep(400);
    await printStatus('Setup completed successfully', 'success');
    console.log();
    
    console.log(`${colors.bright}Configuration Details:${colors.reset}`);
    console.log(`  ${colors.dim}Location:${colors.reset} ${configPath}`);
    console.log(`  ${colors.dim}Status:${colors.reset} ${isNew ? 'Created' : 'Updated'}`);
    console.log();
    
    console.log(`${colors.bright}Next Steps:${colors.reset}`);
    console.log(`  1. Fully quit Claude Desktop (check system tray)`);
    console.log(`  2. Relaunch Claude Desktop`);
    console.log(`  3. Look for the connection indicator to access Materio tools`);
    console.log();
    
    console.log(`${colors.dim}For support, visit: https://materio.vercel.app/support${colors.reset}\n`);
    
  } catch (err) {
    await printProgress(4, 4, 'Setup complete');
    console.log();
    await printStatus(
      `Failed to save configuration: ${err.message}`,
      'error'
    );
    console.log();
    process.exit(1);
  }
}

// Run setup with error handling
setup().catch((err) => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
