#!/usr/bin/env node
/**
 * Plano PM MCP (v2.0)
 * ==============================
 * Copyright (C) 2026 nopan-studio
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, normalize } from "path";

// ─── Configuration ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = __dirname;
const DEFAULT_PORT = 5000;
const BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const HEALTH_URL = `${BASE_URL}/health`;
const AUTH_TOKEN = process.env.PLANO_TOKEN || "plano_system_local_dev";

// ─── Flask lifecycle helpers ─────────────────────────────────────────────────

let _flaskProc = null;

async function _isServerRunning() {
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    return data?.status === "ok";
  } catch {
    return false;
  }
}

function _findVenvPython() {
  const isWin = process.platform === "win32";
  const ext = isWin ? "Scripts/python.exe" : "bin/python";
  const candidates = [
    join(PROJECT_DIR, "venv", ext),
    join(PROJECT_DIR, "..", "venv", ext),
    join(PROJECT_DIR, ".venv", ext),
    join(PROJECT_DIR, "..", ".venv", ext),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "python3"; // fallback to system python
}

async function _ensureServer() {
  if (await _isServerRunning()) return;

  const python = _findVenvPython();
  _flaskProc = spawn(python, ["run.py", "--port", String(DEFAULT_PORT)], {
    cwd: PROJECT_DIR,
    stdio: "ignore",
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await _isServerRunning()) return;
  }
  throw new Error(`Plano server failed to start on port ${DEFAULT_PORT} after 15s`);
}

function _shutdownServer() {
  if (_flaskProc && !_flaskProc.killed) {
    _flaskProc.kill("SIGTERM");
    setTimeout(() => { if (!_flaskProc.killed) _flaskProc.kill("SIGKILL"); }, 5000);
  }
}

process.on("exit", _shutdownServer);
process.on("SIGINT", () => { _shutdownServer(); process.exit(0); });
process.on("SIGTERM", () => { _shutdownServer(); process.exit(0); });

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function _api(method, path, body = null, toolName = null) {
  await _ensureServer();

  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AUTH_TOKEN}`
    },
    signal: AbortSignal.timeout(30000),
  };
  if (toolName) opts.headers["X-Plano-Tool"] = toolName;
  if (body !== null) opts.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { error: text }; }
  } catch (err) {
    return { error: String(err) };
  }
}

// Wraps any value into the MCP tool return format
function _ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ─── Auto-position helper ────────────────────────────────────────────────────

async function _autoPosition(projectId, diagramId) {
  const NODE_H_SPACING = 300;
  const NODE_V_SPACING = 120;
  const NODES_PER_ROW = 4;
  const START_X = 100;
  const START_Y = 100;

  try {
    const existing = await _api("GET", `/api/projects/${projectId}/boards/${diagramId}/nodes`);
    if (Array.isArray(existing) && existing.length) {
      const count = existing.length;
      const col = count % NODES_PER_ROW;
      const row = Math.floor(count / NODES_PER_ROW);
      return [START_X + col * NODE_H_SPACING, START_Y + row * NODE_V_SPACING];
    }
  } catch {}
  return [START_X, START_Y];
}

// ─── Resolve board helper ────────────────────────────────────────────────────

async function _resolveProjectId(projectId, diagramId) {
  if (projectId < 0 && diagramId > 0) {
    const res = await _api("GET", `/api/resolve-board/${diagramId}`);
    if (res?.project_id) return res.project_id;
  }
  return projectId;
}

// ─── Git helper ──────────────────────────────────────────────────────────────

function _gitChangedFiles(workspacePath, sinceRef = "") {
  const cwd = workspacePath || ".";
  const results = [];

  if (!existsSync(join(cwd, ".git"))) return [];

  const statusMap = {
    A: "added", M: "modified", D: "deleted",
    R: "renamed", C: "copied", "?": "untracked",
  };

  try {
    spawnSync("git", ["--version"], { timeout: 5000 });

    const diffArgs = sinceRef
      ? ["--no-pager", "diff", "--name-status", sinceRef, "HEAD"]
      : ["--no-pager", "diff", "--name-status", "HEAD"];

    const proc = spawnSync("git", diffArgs, { cwd, encoding: "utf8", timeout: 15000 });
    for (const line of (proc.stdout || "").trim().split("\n").filter(Boolean)) {
      const parts = line.split("\t", 2);
      if (parts.length === 2) {
        const code = parts[0][0];
        const action = statusMap[code] || "modified";
        const relPath = parts[1];
        const fullPath = normalize(join(cwd, relPath));
        const mtime = existsSync(fullPath) ? statSync(fullPath).mtimeMs : 0;
        results.push({ action, path: relPath, mtime });
      }
    }

    if (!sinceRef) {
      const proc2 = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd, encoding: "utf8", timeout: 15000,
      });
      for (const line of (proc2.stdout || "").trim().split("\n").filter(Boolean)) {
        const fullPath = normalize(join(cwd, line));
        const mtime = existsSync(fullPath) ? statSync(fullPath).mtimeMs : 0;
        results.push({ action: "added", path: line, mtime });
      }
    }
  } catch {}

  return results;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "Plano MCP",
  version: "2.0.0",
  instructions:
    "Plano is a full Project Management system that tracks projects, " +
    "tasks, milestones, changelogs, updates, ideas, and visual boards " +
    "(process flows, DB diagrams, flowcharts, function flows, idea maps). " +
    "Use these tools to manage projects end-to-end. For creating diagrams " +
    "with many nodes, prefer the bulk_operations tool which auto-layouts " +
    "nodes for clear edge visibility. You do NOT need to specify x/y " +
    "coordinates — the system handles positioning automatically.",
});

// ── Health & Docs ─────────────────────────────────────────────────────────────

server.tool(
  "health_check",
  "Check if the Plano server is running and healthy.",
  {},
  async () => _ok(await _api("GET", "/health"))
);

server.tool(
  "api_docs",
  "Get full machine-readable API documentation for Plano PM (v2.0).",
  {},
  async () => _ok(await _api("GET", "/api"))
);

// ── Projects ──────────────────────────────────────────────────────────────────

server.tool(
  "list_projects",
  "List all projects, optionally filtered by status and/or priority.",
  {
    status: z.string().optional().default("").describe("planning/active/on_hold/completed/archived. Empty = all."),
    priority: z.string().optional().default("").describe("low/medium/high/critical. Empty = all."),
  },
  async ({ status, priority }) => {
    const params = [];
    if (status) params.push(`status=${status}`);
    if (priority) params.push(`priority=${priority}`);
    const path = "/api/projects" + (params.length ? "?" + params.join("&") : "");
    return _ok(await _api("GET", path));
  }
);

server.tool(
  "create_project",
  "Create a new project.",
  {
    name: z.string().describe("Project name."),
    description: z.string().optional().default(""),
    status: z.string().optional().default("planning").describe("planning/active/on_hold/completed/archived"),
    priority: z.string().optional().default("medium").describe("low/medium/high/critical"),
    start_date: z.string().optional().default("").describe("YYYY-MM-DD (optional)"),
    target_date: z.string().optional().default("").describe("YYYY-MM-DD (optional)"),
  },
  async ({ name, description, status, priority, start_date, target_date }) => {
    const body = { name, description, status, priority };
    if (start_date) body.start_date = start_date;
    if (target_date) body.target_date = target_date;
    return _ok(await _api("POST", "/api/projects", body));
  }
);

server.tool(
  "get_project",
  "Get a project with summary stats (task counts, milestone counts, etc.).",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("GET", `/api/projects/${project_id}`))
);

server.tool(
  "update_project",
  "Update a project's properties. Only provided fields are changed.",
  {
    project_id: z.number().int(),
    name: z.string().optional().default(""),
    description: z.string().optional().default(""),
    status: z.string().optional().default(""),
    priority: z.string().optional().default(""),
    progress_pct: z.number().int().optional().default(-1).describe("-1 = keep"),
    start_date: z.string().optional().default(""),
    target_date: z.string().optional().default(""),
  },
  async ({ project_id, name, description, status, priority, progress_pct, start_date, target_date }) => {
    const body = {};
    if (name) body.name = name;
    if (description) body.description = description;
    if (status) body.status = status;
    if (priority) body.priority = priority;
    if (progress_pct >= 0) body.progress_pct = progress_pct;
    if (start_date) body.start_date = start_date;
    if (target_date) body.target_date = target_date;
    return _ok(await _api("PATCH", `/api/projects/${project_id}`, body));
  }
);

server.tool(
  "delete_project",
  "Delete a project and all its tasks, milestones, boards, etc.",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("DELETE", `/api/projects/${project_id}`))
);

server.tool(
  "export_project",
  "Export an entire project as a high-fidelity JSON blob (metadata, milestones, tasks, diagrams, ideas, updates, changelog).",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("GET", `/api/projects/${project_id}/export`))
);

server.tool(
  "import_project",
  "Import a project from a previously exported JSON blob.",
  { export_blob: z.string().describe("JSON string of the project export.") },
  async ({ export_blob }) => _ok(await _api("POST", "/api/projects/import", JSON.parse(export_blob)))
);

server.tool(
  "project_dashboard",
  "Get a project dashboard with task/milestone stats and recent changes.",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("GET", `/api/projects/${project_id}/dashboard`))
);

// ── Tasks ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_tasks",
  "List tasks in a project, optionally filtered. Returns minimal fields by default for token efficiency.",
  {
    project_id: z.number().int(),
    status: z.string().optional().default("").describe("bugs/todo/in_progress/review/done. Empty = all."),
    assignee: z.string().optional().default(""),
    milestone_id: z.number().int().optional().default(-1).describe("-1 = all"),
    include_archived: z.boolean().optional().default(false),
    fields: z.string().optional().default("id,title,status,priority,assignee")
      .describe("Comma-separated fields. Available: id,project_id,milestone_id,title,description,assignee,status,priority,due_date,estimated_hours,actual_hours,tags,is_ai_working,created_at"),
  },
  async ({ project_id, status, assignee, milestone_id, include_archived, fields }) => {
    const params = [];
    if (status) params.push(`status=${status}`);
    if (assignee) params.push(`assignee=${assignee}`);
    if (milestone_id >= 0) params.push(`milestone_id=${milestone_id}`);
    if (include_archived) params.push("include_archived=true");
    if (fields) params.push(`fields=${fields}`);
    const path = `/api/projects/${project_id}/tasks` + (params.length ? "?" + params.join("&") : "");
    return _ok(await _api("GET", path));
  }
);

server.tool(
  "get_task",
  "Get details of a specific task.",
  { project_id: z.number().int(), task_id: z.number().int() },
  async ({ project_id, task_id }) => _ok(await _api("GET", `/api/projects/${project_id}/tasks/${task_id}`))
);

server.tool(
  "create_task",
  "Create a task in a project. Auto-logs to changelog.",
  {
    project_id: z.number().int(),
    title: z.string(),
    description: z.string().optional().default(""),
    assignee: z.string().optional().default(""),
    status: z.string().optional().default("todo").describe("bugs/todo/in_progress/review/done"),
    priority: z.string().optional().default("medium").describe("low/medium/high/critical"),
    milestone_id: z.number().int().optional().default(-1).describe("-1 = none"),
    due_date: z.string().optional().default("").describe("YYYY-MM-DD"),
    estimated_hours: z.number().optional().default(-1).describe("-1 = none"),
    tags: z.string().optional().default("[]").describe("JSON array string of tags"),
    files_meta: z.string().optional().default("[]").describe("JSON array string of files metadata"),
    is_ai_working: z.number().int().optional().default(-1).describe("1=active, 0=inactive, -1=skip"),
  },
  async ({ project_id, title, description, assignee, status, priority, milestone_id, due_date, estimated_hours, tags, files_meta, is_ai_working }) => {
    const bodyMeta = {};
    if (is_ai_working === 1 || (status === "in_progress" && is_ai_working === -1)) {
      const snapshot = _gitChangedFiles(PROJECT_DIR);
      if (snapshot.length) bodyMeta.capture_snapshot = snapshot;
    }
    const body = {
      title, description, assignee, status, priority,
      tags: JSON.parse(tags),
      files_meta: JSON.parse(files_meta),
      meta: bodyMeta,
    };
    if (is_ai_working !== -1) body.is_ai_working = Boolean(is_ai_working);
    else if (status === "in_progress") body.is_ai_working = true;
    if (milestone_id >= 0) body.milestone_id = milestone_id;
    if (due_date) body.due_date = due_date;
    if (estimated_hours >= 0) body.estimated_hours = estimated_hours;
    return _ok(await _api("POST", `/api/projects/${project_id}/tasks`, body));
  }
);

server.tool(
  "update_task",
  "Update a task. Changes are auto-logged to the changelog.",
  {
    project_id: z.number().int(),
    task_id: z.number().int(),
    title: z.string().optional().default(""),
    description: z.string().optional().default(""),
    assignee: z.string().optional().default(""),
    status: z.string().optional().default("").describe("bugs/todo/in_progress/review/done"),
    priority: z.string().optional().default(""),
    due_date: z.string().optional().default(""),
    estimated_hours: z.number().optional().default(-1),
    actual_hours: z.number().optional().default(-1),
    files_meta: z.string().optional().default(""),
    meta: z.string().optional().default(""),
    is_ai_working: z.number().int().optional().default(-1).describe("1=active, 0=inactive, -1=keep"),
  },
  async ({ project_id, task_id, title, description, assignee, status, priority, due_date, estimated_hours, actual_hours, files_meta, meta, is_ai_working }) => {
    const body = {};
    if (title) body.title = title;
    if (description) body.description = description;
    if (meta) body.meta = JSON.parse(meta);
    if (assignee) body.assignee = assignee;
    if (status) body.status = status;
    if (priority) body.priority = priority;
    if (due_date) body.due_date = due_date;
    if (estimated_hours >= 0) body.estimated_hours = estimated_hours;
    if (actual_hours >= 0) body.actual_hours = actual_hours;
    if (files_meta) body.files_meta = JSON.parse(files_meta);

    if (is_ai_working !== -1) body.is_ai_working = Boolean(is_ai_working);
    else if (status === "in_progress") body.is_ai_working = true;
    else if (["bugs", "todo", "done", "review"].includes(status)) body.is_ai_working = false;

    // Snapshot logic: take snapshot when transitioning to is_ai_working=true
    if (body.is_ai_working === true) {
      try {
        const current = await _api("GET", `/api/projects/${project_id}/tasks/${task_id}`);
        if (!current.is_ai_working) {
          const snapshot = _gitChangedFiles(PROJECT_DIR);
          if (snapshot.length) {
            let existingMeta = typeof current.meta === "object" && current.meta ? current.meta : {};
            const newMeta = typeof body.meta === "object" && body.meta ? body.meta : existingMeta;
            newMeta.capture_snapshot = snapshot;
            body.meta = newMeta;
          }
        }
      } catch {}
    }

    return _ok(await _api("PATCH", `/api/projects/${project_id}/tasks/${task_id}`, body));
  }
);

server.tool(
  "delete_task",
  "Delete a task.",
  { project_id: z.number().int(), task_id: z.number().int() },
  async ({ project_id, task_id }) => _ok(await _api("DELETE", `/api/projects/${project_id}/tasks/${task_id}`))
);

server.tool(
  "set_ai_working_status",
  "Explicitly set the AI working indicator for a task without changing its status.",
  {
    project_id: z.number().int(),
    task_id: z.number().int(),
    is_working: z.boolean(),
  },
  async ({ project_id, task_id, is_working }) => {
    const body = { is_ai_working: is_working };
    if (is_working) {
      try {
        const current = await _api("GET", `/api/projects/${project_id}/tasks/${task_id}`);
        if (!current.is_ai_working) {
          const snapshot = _gitChangedFiles(PROJECT_DIR);
          if (snapshot.length) {
            let taskMeta = typeof current.meta === "object" && current.meta ? current.meta : {};
            taskMeta.capture_snapshot = snapshot;
            body.meta = taskMeta;
            return _ok(await _api("PATCH", `/api/projects/${project_id}/tasks/${task_id}`, body));
          }
        }
      } catch {}
    }
    return _ok(await _api("POST", `/api/projects/${project_id}/tasks/${task_id}/ai-status`, body));
  }
);

// ── Milestones ────────────────────────────────────────────────────────────────

server.tool(
  "list_milestones",
  "List all milestones in a project.",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("GET", `/api/projects/${project_id}/milestones`))
);

server.tool(
  "create_milestone",
  "Create a milestone in a project.",
  {
    project_id: z.number().int(),
    name: z.string(),
    description: z.string().optional().default(""),
    due_date: z.string().optional().default("").describe("YYYY-MM-DD"),
    status: z.string().optional().default("pending").describe("pending/in_progress/completed/missed"),
  },
  async ({ project_id, name, description, due_date, status }) => {
    const body = { name, description, status };
    if (due_date) body.due_date = due_date;
    return _ok(await _api("POST", `/api/projects/${project_id}/milestones`, body));
  }
);

server.tool(
  "update_milestone",
  "Update a milestone.",
  {
    project_id: z.number().int(),
    milestone_id: z.number().int(),
    name: z.string().optional().default(""),
    description: z.string().optional().default(""),
    due_date: z.string().optional().default(""),
    status: z.string().optional().default(""),
  },
  async ({ project_id, milestone_id, name, description, due_date, status }) => {
    const body = {};
    if (name) body.name = name;
    if (description) body.description = description;
    if (due_date) body.due_date = due_date;
    if (status) body.status = status;
    return _ok(await _api("PATCH", `/api/projects/${project_id}/milestones/${milestone_id}`, body));
  }
);

// ── Changelog ─────────────────────────────────────────────────────────────────

server.tool(
  "get_changelog",
  "Get paginated changelog for a project.",
  {
    project_id: z.number().int(),
    entity_type: z.string().optional().default("").describe("project/task/milestone/board"),
    action: z.string().optional().default("").describe("created/updated/deleted"),
    page: z.number().int().optional().default(1),
  },
  async ({ project_id, entity_type, action, page }) => {
    const params = [`page=${page}`];
    if (entity_type) params.push(`entity_type=${entity_type}`);
    if (action) params.push(`action=${action}`);
    return _ok(await _api("GET", `/api/projects/${project_id}/changelog?${params.join("&")}`));
  }
);

// ── Updates ───────────────────────────────────────────────────────────────────

server.tool(
  "list_updates",
  "List progress updates for a project.",
  {
    project_id: z.number().int(),
    update_type: z.string().optional().default("").describe("progress/blocker/decision/bug_fix/note"),
  },
  async ({ project_id, update_type }) => {
    let path = `/api/projects/${project_id}/updates`;
    if (update_type) path += `?type=${update_type}`;
    return _ok(await _api("GET", path));
  }
);

server.tool(
  "post_update",
  "Post a progress update to a project.",
  {
    project_id: z.number().int(),
    content: z.string().describe("Update content (supports markdown)."),
    update_type: z.string().optional().default("progress").describe("progress/blocker/decision/bug_fix/note"),
    task_id: z.number().int().optional().default(-1).describe("-1 = none"),
    files_meta: z.string().optional().default("[]"),
  },
  async ({ project_id, content, update_type, task_id, files_meta }) => {
    const body = { content, update_type, files_meta: JSON.parse(files_meta) };
    if (task_id >= 0) body.task_id = task_id;
    return _ok(await _api("POST", `/api/projects/${project_id}/updates`, body));
  }
);

// ── Ideas ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_ideas",
  "List ideas, optionally filtered by project and/or status.",
  {
    project_id: z.number().int().optional().default(-1).describe("-1 = all projects"),
    status: z.string().optional().default("").describe("new/exploring/accepted/implemented/rejected"),
  },
  async ({ project_id, status }) => {
    const params = [];
    if (project_id >= 0) params.push(`project_id=${project_id}`);
    if (status) params.push(`status=${status}`);
    const path = "/api/ideas" + (params.length ? "?" + params.join("&") : "");
    return _ok(await _api("GET", path));
  }
);

server.tool(
  "create_idea",
  "Create an idea, optionally scoped to a project.",
  {
    title: z.string(),
    description: z.string().optional().default(""),
    project_id: z.number().int().optional().default(-1).describe("-1 = global idea"),
    milestone_id: z.number().int().optional().default(-1),
    tags: z.string().optional().default("[]").describe("JSON array string of tags"),
  },
  async ({ title, description, project_id, milestone_id, tags }) => {
    const body = { title, description, tags: JSON.parse(tags) };
    if (project_id >= 0) body.project_id = project_id;
    if (milestone_id >= 0) body.milestone_id = milestone_id;
    return _ok(await _api("POST", "/api/ideas", body));
  }
);

server.tool(
  "vote_idea",
  "Upvote an idea.",
  { idea_id: z.number().int() },
  async ({ idea_id }) => _ok(await _api("POST", `/api/ideas/${idea_id}/vote`, {}))
);

server.tool(
  "update_idea",
  "Update an idea. Only provided fields are changed.",
  {
    idea_id: z.number().int(),
    title: z.string().optional().default(""),
    description: z.string().optional().default(""),
    status: z.string().optional().default("").describe("new/exploring/accepted/implemented/rejected"),
    project_id: z.number().int().optional().default(-1).describe("-1 = keep, -2 = remove"),
    milestone_id: z.number().int().optional().default(-1).describe("-1 = keep, -2 = remove"),
    tags: z.string().optional().default("").describe("JSON array string"),
  },
  async ({ idea_id, title, description, status, project_id, milestone_id, tags }) => {
    const body = {};
    if (title) body.title = title;
    if (description) body.description = description;
    if (status) body.status = status;
    if (project_id === -2) body.project_id = null;
    else if (project_id >= 0) body.project_id = project_id;
    if (milestone_id === -2) body.milestone_id = null;
    else if (milestone_id >= 0) body.milestone_id = milestone_id;
    if (tags) body.tags = JSON.parse(tags);
    return _ok(await _api("PATCH", `/api/ideas/${idea_id}`, body));
  }
);

// ── Diagrams (Boards) ─────────────────────────────────────────────────────────

server.tool(
  "list_diagrams",
  "List all boards/diagrams, optionally filtered by type.",
  {
    project_id: z.number().int(),
    diagram_type: z.string().optional().default("").describe("process_flow/db_diagram/flowchart/idea_map/function_flow"),
  },
  async ({ project_id, diagram_type }) => {
    if (project_id < 0) return _ok({ error: "project_id is required." });
    let path = `/api/projects/${project_id}/boards`;
    if (diagram_type) path += `?type=${diagram_type}`;
    return _ok(await _api("GET", path));
  }
);

server.tool(
  "create_diagram",
  "Create a new board/diagram.",
  {
    name: z.string(),
    project_id: z.number().int().optional().default(-1),
    diagram_type: z.string().optional().default("process_flow").describe("process_flow/db_diagram/flowchart/idea_map/function_flow"),
    description: z.string().optional().default(""),
  },
  async ({ name, project_id, diagram_type, description }) => {
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("POST", `/api/projects/${project_id}/boards`, { name, type: diagram_type, description }));
  }
);

server.tool(
  "get_diagram",
  "Get a diagram/board with all its nodes and edges.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("GET", `/api/projects/${project_id}/boards/${diagram_id}`));
  }
);

server.tool(
  "update_diagram",
  "Update a diagram's metadata.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
    name: z.string().optional().default(""),
    description: z.string().optional().default(""),
    diagram_type: z.string().optional().default(""),
  },
  async ({ project_id, diagram_id, name, description, diagram_type }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    const body = {};
    if (name) body.name = name;
    if (description) body.description = description;
    if (diagram_type) body.type = diagram_type;
    return _ok(await _api("PATCH", `/api/projects/${project_id}/boards/${diagram_id}`, body));
  }
);

server.tool(
  "delete_diagram",
  "Delete a diagram and all its nodes and edges.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("DELETE", `/api/projects/${project_id}/boards/${diagram_id}`));
  }
);

server.tool(
  "duplicate_diagram",
  "Duplicate a diagram with all nodes and edges (new IDs are assigned).",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/duplicate`, {}));
  }
);

server.tool(
  "create_board_from_template",
  "Create a board from a pre-built template.",
  {
    project_id: z.number().int(),
    template: z.string().describe("sprint_planning/release_pipeline/bug_triage/feature_request/onboarding"),
    name: z.string().optional().default("").describe("Custom name (empty = use template default)"),
  },
  async ({ project_id, template, name }) => {
    const body = { template };
    if (name) body.name = name;
    return _ok(await _api("POST", `/api/projects/${project_id}/boards/from-template`, body));
  }
);

// ── Nodes ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_nodes",
  "List all nodes in a diagram.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("GET", `/api/projects/${project_id}/boards/${diagram_id}/nodes`));
  }
);

server.tool(
  "create_node",
  "Create a new node in a diagram. Omit x/y for auto-positioning.",
  {
    project_id: z.number().int(),
    diagram_id: z.number().int(),
    label: z.string(),
    node_type: z.string().optional().default("default"),
    x: z.number().optional().default(-1).describe("-1 = auto-position"),
    y: z.number().optional().default(-1).describe("-1 = auto-position"),
    width: z.number().optional().default(160),
    height: z.number().optional().default(60),
    meta: z.string().optional().default("{}").describe('For db_table: {"columns":[{"name":"id","type":"INT","is_pk":true}]}'),
  },
  async ({ project_id, diagram_id, label, node_type, x, y, width, height, meta }) => {
    if (x < 0 || y < 0) {
      [x, y] = await _autoPosition(project_id, diagram_id);
    }
    return _ok(await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/nodes`, {
      label, node_type, x, y, width, height, meta: JSON.parse(meta),
    }));
  }
);

server.tool(
  "get_node",
  "Get a single node.",
  {
    node_id: z.number().int(),
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ node_id, project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("GET", `/api/projects/${project_id}/boards/${diagram_id}/nodes/${node_id}`));
  }
);

server.tool(
  "update_node",
  "Update a node. Only provided fields are changed.",
  {
    project_id: z.number().int(),
    diagram_id: z.number().int(),
    node_id: z.number().int(),
    label: z.string().optional().default(""),
    node_type: z.string().optional().default(""),
    x: z.number().optional().default(-1),
    y: z.number().optional().default(-1),
    width: z.number().optional().default(-1),
    height: z.number().optional().default(-1),
    meta: z.string().optional().default(""),
  },
  async ({ project_id, diagram_id, node_id, label, node_type, x, y, width, height, meta }) => {
    const body = {};
    if (label) body.label = label;
    if (node_type) body.node_type = node_type;
    if (x >= 0) body.x = x;
    if (y >= 0) body.y = y;
    if (width >= 0) body.width = width;
    if (height >= 0) body.height = height;
    if (meta) body.meta = JSON.parse(meta);
    return _ok(await _api("PATCH", `/api/projects/${project_id}/boards/${diagram_id}/nodes/${node_id}`, body));
  }
);

server.tool(
  "delete_node",
  "Delete a node and all its connected edges.",
  {
    node_id: z.number().int(),
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ node_id, project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("DELETE", `/api/projects/${project_id}/boards/${diagram_id}/nodes/${node_id}`));
  }
);

// ── Edges ─────────────────────────────────────────────────────────────────────

server.tool(
  "list_edges",
  "List all edges in a diagram.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("GET", `/api/projects/${project_id}/boards/${diagram_id}/edges`));
  }
);

server.tool(
  "create_edge",
  "Create an edge connecting two nodes.",
  {
    project_id: z.number().int(),
    diagram_id: z.number().int(),
    source_id: z.number().int(),
    target_id: z.number().int(),
    label: z.string().optional().default(""),
    edge_type: z.string().optional().default("default"),
    meta: z.string().optional().default("{}"),
    source_column: z.string().optional().default("").describe("For DB diagrams: source column name"),
    target_column: z.string().optional().default("").describe("For DB diagrams: target column name"),
  },
  async ({ project_id, diagram_id, source_id, target_id, label, edge_type, meta, source_column, target_column }) => {
    const m = JSON.parse(meta);
    if (source_column) m.source_column = source_column;
    if (target_column) m.target_column = target_column;
    return _ok(await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/edges`, {
      source_id, target_id, label, edge_type, meta: m,
    }));
  }
);

server.tool(
  "get_edge",
  "Get a single edge.",
  {
    edge_id: z.number().int(),
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ edge_id, project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("GET", `/api/projects/${project_id}/boards/${diagram_id}/edges/${edge_id}`));
  }
);

server.tool(
  "update_edge",
  "Update an edge. Only provided fields are changed.",
  {
    project_id: z.number().int(),
    diagram_id: z.number().int(),
    edge_id: z.number().int(),
    label: z.string().optional().default(""),
    edge_type: z.string().optional().default(""),
    meta: z.string().optional().default(""),
    source_column: z.string().optional().default(""),
    target_column: z.string().optional().default(""),
  },
  async ({ project_id, diagram_id, edge_id, label, edge_type, meta, source_column, target_column }) => {
    const body = {};
    if (label) body.label = label;
    if (edge_type) body.edge_type = edge_type;
    const m = meta ? JSON.parse(meta) : {};
    if (source_column) m.source_column = source_column;
    if (target_column) m.target_column = target_column;
    if (Object.keys(m).length) body.meta = m;
    return _ok(await _api("PATCH", `/api/projects/${project_id}/boards/${diagram_id}/edges/${edge_id}`, body));
  }
);

server.tool(
  "delete_edge",
  "Delete an edge.",
  {
    edge_id: z.number().int(),
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
  },
  async ({ edge_id, project_id, diagram_id }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("DELETE", `/api/projects/${project_id}/boards/${diagram_id}/edges/${edge_id}`));
  }
);

// ── Bulk ──────────────────────────────────────────────────────────────────────

server.tool(
  "bulk_operations",
  `Apply multiple operations atomically on a diagram. PREFERRED for building diagrams with many nodes/edges.
Use "_ref" strings in create_node ops, then reference them as source_id/target_id in create_edge ops.
Example: [{"action":"create_node","_ref":"n1","label":"Start"},{"action":"create_edge","source_id":"n1","target_id":"n2"}]`,
  {
    operations: z.string().describe("JSON array of operation objects. Actions: create_node, update_node, delete_node, create_edge, update_edge, delete_edge, update_diagram."),
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
    auto_layout: z.boolean().optional().default(true).describe("Auto-apply hierarchical layout after ops. Set false to preserve manual positions."),
  },
  async ({ operations, project_id, diagram_id, auto_layout }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });

    const ops = JSON.parse(operations);
    for (const op of ops) {
      if (op.meta && typeof op.meta === "string") {
        try { op.meta = JSON.parse(op.meta); } catch {}
      }
    }

    let result = await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/bulk`, { ops });

    if (auto_layout && !result.error) {
      const layoutResult = await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/auto-layout`, {
        direction: "LR",
        node_spacing: 80,
        rank_spacing: 280,
      });
      if (layoutResult.id && layoutResult.nodes) {
        result.diagram = layoutResult;
      }
    }

    return _ok(result);
  }
);

// ── Layout ────────────────────────────────────────────────────────────────────

server.tool(
  "auto_layout",
  "Auto-layout all nodes in a diagram for clear, readable positioning using a hierarchical algorithm.",
  {
    project_id: z.number().int().optional().default(-1),
    diagram_id: z.number().int().optional().default(-1),
    direction: z.string().optional().default("LR").describe("LR (left-to-right) or TB (top-to-bottom)"),
    node_spacing: z.number().int().optional().default(80).describe("Vertical gap between nodes in same rank (px)"),
    rank_spacing: z.number().int().optional().default(280).describe("Horizontal gap between ranks/columns (px)"),
  },
  async ({ project_id, diagram_id, direction, node_spacing, rank_spacing }) => {
    project_id = await _resolveProjectId(project_id, diagram_id);
    if (project_id < 0) return _ok({ error: "project_id is required." });
    return _ok(await _api("POST", `/api/projects/${project_id}/boards/${diagram_id}/auto-layout`, {
      direction, node_spacing, rank_spacing,
    }));
  }
);

// ── Task archive tools ────────────────────────────────────────────────────────

server.tool(
  "archive_all_done_tasks",
  "Archive all tasks with status 'done' in a project (bulk cleanup).",
  { project_id: z.number().int() },
  async ({ project_id }) => _ok(await _api("POST", `/api/projects/${project_id}/tasks/archive-done`))
);

server.tool(
  "archive_task",
  "Archive a single task and preserve its original status in metadata.",
  { project_id: z.number().int(), task_id: z.number().int() },
  async ({ project_id, task_id }) => {
    await _ensureServer();
    const tRes = await _api("GET", `/api/projects/${project_id}/tasks/${task_id}`);
    if (tRes.error) return _ok(tRes);

    const orgStatus = tRes.status || "todo";
    const meta = typeof tRes.meta === "object" && tRes.meta ? tRes.meta : {};
    meta.original_status = orgStatus;

    return _ok(await _api("PATCH", `/api/projects/${project_id}/tasks/${task_id}`, {
      status: "archived",
      meta,
    }));
  }
);

// ── File Change Capture ───────────────────────────────────────────────────────

server.tool(
  "capture_file_changes",
  "Capture file changes from a Git workspace and log them to a Plano task. Best used by AI agents after completing work.",
  {
    project_id: z.number().int(),
    task_id: z.number().int(),
    workspace_path: z.string().optional().default("").describe("Absolute path to git root. Empty = Plano project dir."),
    since_ref: z.string().optional().default("").describe("Git ref to diff against. Empty = uncommitted changes vs HEAD."),
    auto_update_task: z.boolean().optional().default(true).describe("If true, patches task files_meta with captured changes."),
    is_ai_working: z.number().int().optional().default(-1).describe("1=active, 0=inactive, -1=keep"),
    ignore_snapshot: z.boolean().optional().default(false).describe("If true, use raw git diff without task snapshot filtering."),
  },
  async ({ project_id, task_id, workspace_path, since_ref, auto_update_task, is_ai_working, ignore_snapshot }) => {
    const wsPath = workspace_path || PROJECT_DIR;
    let changes = _gitChangedFiles(wsPath, since_ref);

    // Filter by task snapshot if available
    if (!since_ref && !ignore_snapshot) {
      try {
        const tRes = await _api("GET", `/api/projects/${project_id}/tasks/${task_id}`);
        let taskMeta = tRes.meta || {};
        if (typeof taskMeta === "string") {
          try { taskMeta = JSON.parse(taskMeta); } catch { taskMeta = {}; }
        }
        if (typeof taskMeta === "object" && taskMeta.capture_snapshot) {
          const snapshotMtimes = Object.fromEntries(
            taskMeta.capture_snapshot.map((s) => [s.path, s.mtime || 0])
          );
          changes = changes.filter((c) =>
            !(c.path in snapshotMtimes) || (c.mtime || 0) > snapshotMtimes[c.path]
          );
        }
      } catch {}
    }

    // Capture diffs
    for (const c of changes) {
      if (c.action === "deleted") {
        c.diff = "<File deleted>";
      } else {
        try {
          const proc = spawnSync("git", ["--no-pager", "diff", "HEAD", "--", c.path], {
            cwd: wsPath, encoding: "utf8", timeout: 15000,
          });
          if (proc.stdout) {
            c.diff = proc.stdout.length > 2000
              ? proc.stdout.slice(0, 2000) + "\n...[diff truncated]"
              : proc.stdout;
          } else {
            const proc2 = spawnSync("git", ["ls-files", "--others", "--exclude-standard", c.path], {
              cwd: wsPath, encoding: "utf8", timeout: 15000,
            });
            c.diff = proc2.stdout?.trim() === c.path ? "<New untracked file>" : "<Binary or no delta>";
          }
        } catch (e) {
          c.diff = `<Failed to capture diff: ${e.message}>`;
        }
      }
    }

    const result = {
      workspace: wsPath,
      since_ref: since_ref || "HEAD (filtered by task snapshot)",
      files_changed: changes.length,
      changes,
    };

    if (auto_update_task && changes.length) {
      const patchBody = { files_meta: changes };
      if (is_ai_working !== -1) patchBody.is_ai_working = Boolean(is_ai_working);
      result.task_updated = true;
      result.task = await _api("PATCH", `/api/projects/${project_id}/tasks/${task_id}`, patchBody);
    } else {
      result.task_updated = false;
    }

    return _ok(result);
  }
);

// ─── Entry point ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
