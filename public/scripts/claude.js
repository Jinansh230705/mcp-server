#!/usr/bin/env node

/**
 * Public installer for Claude Desktop MCP config.
 * Served from https://materiomcp.vercel.app/scripts/claude.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const SERVER_NAME = 'materio';
const REMOTE_URL = 'https://materiomcp.vercel.app/mcp';

function getClaudeConfigPath() {
  const platform = os.platform();

  if (platform === 'win32') {
    return path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Claude',
      'claude_desktop_config.json'
    );
  }

  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }

  throw new Error(`Unsupported OS: ${platform}. Supported: Windows, macOS`);
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }

  const raw = fs.readFileSync(configPath, 'utf8').trim();
  const parsed = raw ? JSON.parse(raw) : {};

  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    parsed.mcpServers = {};
  }

  return parsed;
}

function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function run() {
  const configPath = getClaudeConfigPath();
  const config = loadConfig(configPath);

  config.mcpServers[SERVER_NAME] = {
    command: 'npx',
    args: ['-y', 'mcp-remote', REMOTE_URL],
    logo: 'https://materiomcp.vercel.app/logo.png'
  };

  saveConfig(configPath, config);

  process.stdout.write('Materio MCP configured for Claude Desktop.\n');
  process.stdout.write(`Config updated: ${configPath}\n`);
  process.stdout.write('Fully quit Claude Desktop, then reopen it.\n');
}

try {
  run();
} catch (error) {
  process.stderr.write(`Setup failed: ${error.message}\n`);
  process.exit(1);
}
