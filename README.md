# Plano MCP Server

[![npm version](https://img.shields.io/npm/v/plano-mcp.svg)](https://www.npmjs.com/package/plano-mcp)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Plano MCP (Model Context Protocol) Server provides a powerful interface for AI agents to manage projects, tasks, milestones, and visual diagrams within the Plano PM ecosystem.

## Features

- **Project Management**: Create, list, update, and export entire projects.
- **Task Tracking**: Full CRUD for tasks, including priority, assignee, status, and estimation tracking.
- **Visual Diagrams**: Create process flows, DB diagrams, flowcharts, idea maps, and function flows with auto-layout support.
- **Collaboration**: Post progress updates, track changelogs, and manage ideas/suggestions.
- **Milestone Management**: Organize work into time-bound milestones.
- **AI-Native**: Built-in snapshotting of Git changes when AI agents are working on tasks.

## Installation

```bash
npm install -g plano-mcp
```

## Usage

### Configuration for Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "plano": {
      "command": "npx",
      "args": ["-y", "plano-mcp"],
      "env": {
        "PLANO_TOKEN": "your_plano_auth_token"
      }
    }
  }
}
```

### Environment Variables

- `PLANO_TOKEN`: Your Plano PM authentication token (default: `plano_system_local_dev`).
- `PLANO_PORT`: The port your local Plano backend is running on (default: `5000`).

## Architecture

The MCP server acts as a bridge between the Model Context Protocol and the Plano PM backend API. It communicates with a running Plano server via HTTP.

## Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Run the server: `node plano_mcp.js`

## License

Copyright (C) 2026 nopan-studio

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
