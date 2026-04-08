// notion-todo.js — Notion Tasks Tracker Integration for TVMbot
// Two-way sync with Notion "Tasks tracker" database
// Database ID: 2c33c8b985f180dd858df934d521ec32

const { Client } = require('@notionhq/client');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const DATABASE_ID = '2c33c8b985f180dd858df934d521ec32';

// User mapping: chat names → Notion people names
const USER_MAP = {
  'afni': 'Afni Hendrani',
  'sof': 'Sofiane',
  'sofiane': 'Sofiane',
  'syifa': 'Syifa Kurnia Febryanti',
};

const VALID_STATUSES = ['Not started', 'In progress', 'Done'];
const VALID_PRIORITIES = ['Superhigh', 'High', 'Medium'];

let notionClient = null;

// ─── Initialize ────────────────────────────────────────────────────────────────
function getClient() {
  if (notionClient) return notionClient;
  try {
    const config = require('../config/integrations.json');
    if (!config.notion?.enabled || !config.notion?.api_key || config.notion.api_key === '') {
      return null;
    }
    notionClient = new Client({ auth: config.notion.api_key });
    return notionClient;
  } catch (e) {
    console.warn('[NotionTodo] Config load error:', e.message);
    return null;
  }
}

function isConfigured() {
  return !!getClient();
}

// ─── Helper: Parse Notion page to task object ──────────────────────────────────
function parseTask(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    task_name: props['Task name']?.title?.[0]?.plain_text || 'Untitled',
    status: props['Status']?.status?.name || props['Status']?.select?.name || 'Not started',
    priority: props['Priority']?.select?.name || '',
    assignee: (props['Assignee']?.people || []).map(p => p.name).join(', ') || 'Unassigned',
    assignee_ids: (props['Assignee']?.people || []).map(p => p.id),
    due_date: props['Due date']?.date?.start || null,
    description: props['Description']?.rich_text?.[0]?.plain_text || '',
    created: page.created_time,
    updated: page.last_edited_time,
    task_type: (props['Task type']?.multi_select || []).map(s => s.name).join(', ') || '',
    url: page.url
  };
}

// ─── Query Tasks ───────────────────────────────────────────────────────────────
async function getTasks(filters = {}) {
  const notion = getClient();
  if (!notion) return { error: 'Notion not configured. Add API key in Settings → Integrations.', tasks: [] };

  try {
    const filterConditions = [];

    // Filter by status (Notion 'status' type, not 'select')
    if (filters.status) {
      const status = VALID_STATUSES.find(s => s.toLowerCase() === filters.status.toLowerCase());
      if (status) {
        filterConditions.push({
          property: 'Status',
          status: { equals: status }
        });
      }
    }

    // Filter by priority
    if (filters.priority) {
      const priority = VALID_PRIORITIES.find(p => p.toLowerCase() === filters.priority.toLowerCase());
      if (priority) {
        filterConditions.push({
          property: 'Priority',
          select: { equals: priority }
        });
      }
    }

    // Filter by assignee name (search in task results since People filter needs user ID)
    const assigneeFilter = filters.assignee ? (USER_MAP[filters.assignee.toLowerCase()] || filters.assignee) : null;

    // Build Notion query
    const queryParams = {
      database_id: DATABASE_ID,
      sorts: [
        { property: 'Priority', direction: 'ascending' },
        { property: 'Due date', direction: 'ascending' }
      ],
      page_size: filters.limit || 50
    };

    if (filterConditions.length === 1) {
      queryParams.filter = filterConditions[0];
    } else if (filterConditions.length > 1) {
      queryParams.filter = { and: filterConditions };
    }

    const response = await notion.databases.query(queryParams);
    let tasks = response.results.map(parseTask);

    // Client-side filter for assignee (Notion People filter needs user IDs)
    if (assigneeFilter) {
      tasks = tasks.filter(t =>
        t.assignee.toLowerCase().includes(assigneeFilter.toLowerCase())
      );
    }

    return {
      tasks,
      total: tasks.length,
      filters_applied: filters
    };
  } catch (err) {
    console.error('[NotionTodo] Query error:', err.message);
    return { error: err.message, tasks: [] };
  }
}

// ─── Create Task ───────────────────────────────────────────────────────────────
async function createTask({ task_name, assignee, priority, due_date, description, status }) {
  const notion = getClient();
  if (!notion) return { error: 'Notion not configured. Add API key in Settings → Integrations.' };

  try {
    const properties = {
      'Task name': {
        title: [{ text: { content: task_name } }]
      }
    };

    // Status (Notion 'status' type)
    if (status) {
      const validStatus = VALID_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (validStatus) properties['Status'] = { status: { name: validStatus } };
    } else {
      properties['Status'] = { status: { name: 'Not started' } };
    }

    // Priority
    if (priority) {
      const validPriority = VALID_PRIORITIES.find(p => p.toLowerCase() === priority.toLowerCase());
      if (validPriority) properties['Priority'] = { select: { name: validPriority } };
    }

    // Due date
    if (due_date) {
      properties['Due date'] = { date: { start: due_date } };
    }

    // Description
    if (description) {
      properties['Description'] = {
        rich_text: [{ text: { content: description } }]
      };
    }

    // Assignee — requires resolving user IDs from Notion
    if (assignee) {
      const resolvedName = USER_MAP[assignee.toLowerCase()] || assignee;
      const userIds = await resolveUserIds([resolvedName]);
      if (userIds.length > 0) {
        properties['Assignee'] = { people: userIds.map(id => ({ id })) };
      }
    }

    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties
    });

    return {
      success: true,
      task: parseTask(page),
      message: `Task "${task_name}" created successfully`
    };
  } catch (err) {
    console.error('[NotionTodo] Create error:', err.message);
    return { error: err.message };
  }
}

// ─── Update Task ───────────────────────────────────────────────────────────────
async function updateTask(taskId, updates) {
  const notion = getClient();
  if (!notion) return { error: 'Notion not configured. Add API key in Settings → Integrations.' };

  try {
    const properties = {};

    if (updates.status) {
      const validStatus = VALID_STATUSES.find(s => s.toLowerCase() === updates.status.toLowerCase());
      if (validStatus) properties['Status'] = { status: { name: validStatus } };
    }

    if (updates.priority) {
      const validPriority = VALID_PRIORITIES.find(p => p.toLowerCase() === updates.priority.toLowerCase());
      if (validPriority) properties['Priority'] = { select: { name: validPriority } };
    }

    if (updates.due_date) {
      properties['Due date'] = { date: { start: updates.due_date } };
    }

    if (updates.description !== undefined) {
      properties['Description'] = {
        rich_text: [{ text: { content: updates.description } }]
      };
    }

    if (updates.task_name) {
      properties['Task name'] = {
        title: [{ text: { content: updates.task_name } }]
      };
    }

    if (updates.assignee) {
      const resolvedName = USER_MAP[updates.assignee.toLowerCase()] || updates.assignee;
      const userIds = await resolveUserIds([resolvedName]);
      if (userIds.length > 0) {
        properties['Assignee'] = { people: userIds.map(id => ({ id })) };
      }
    }

    const page = await notion.pages.update({
      page_id: taskId,
      properties
    });

    return {
      success: true,
      task: parseTask(page),
      message: `Task updated successfully`
    };
  } catch (err) {
    console.error('[NotionTodo] Update error:', err.message);
    return { error: err.message };
  }
}

// ─── Delete Task (archive in Notion) ───────────────────────────────────────────
async function deleteTask(taskId) {
  const notion = getClient();
  if (!notion) return { error: 'Notion not configured.' };

  try {
    await notion.pages.update({
      page_id: taskId,
      archived: true
    });
    return { success: true, message: 'Task archived successfully' };
  } catch (err) {
    console.error('[NotionTodo] Delete error:', err.message);
    return { error: err.message };
  }
}

// ─── Get Task Summary (for dashboard) ──────────────────────────────────────────
async function getTaskSummary() {
  const notion = getClient();
  if (!notion) return { error: 'Notion not configured.', configured: false };

  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: 100
    });

    const tasks = response.results.map(parseTask);
    const byStatus = { 'Not started': 0, 'In progress': 0, 'Done': 0 };
    const byAssignee = {};
    const overdue = [];
    const today = new Date().toISOString().split('T')[0];

    tasks.forEach(t => {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      const assignee = t.assignee || 'Unassigned';
      if (!byAssignee[assignee]) byAssignee[assignee] = { total: 0, done: 0, in_progress: 0 };
      byAssignee[assignee].total++;
      if (t.status === 'Done') byAssignee[assignee].done++;
      if (t.status === 'In progress') byAssignee[assignee].in_progress++;
      if (t.due_date && t.due_date < today && t.status !== 'Done') {
        overdue.push(t);
      }
    });

    return {
      configured: true,
      total: tasks.length,
      by_status: byStatus,
      by_assignee: byAssignee,
      overdue: overdue.length,
      overdue_tasks: overdue.slice(0, 5)
    };
  } catch (err) {
    console.error('[NotionTodo] Summary error:', err.message);
    return { error: err.message, configured: true };
  }
}

// ─── Resolve Notion User IDs from Names ────────────────────────────────────────
let _userCache = null;
async function resolveUserIds(names) {
  const notion = getClient();
  if (!notion) return [];

  try {
    if (!_userCache) {
      const response = await notion.users.list({});
      _userCache = response.results.filter(u => u.type === 'person');
    }

    return names.map(name => {
      const user = _userCache.find(u =>
        u.name && u.name.toLowerCase().includes(name.toLowerCase())
      );
      return user ? user.id : null;
    }).filter(Boolean);
  } catch (err) {
    console.warn('[NotionTodo] User resolve error:', err.message);
    return [];
  }
}

// ─── Clear user cache (for when new users are added) ──────────────────────────
function clearUserCache() {
  _userCache = null;
}

module.exports = {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  getTaskSummary,
  isConfigured,
  clearUserCache,
  DATABASE_ID,
  USER_MAP,
  VALID_STATUSES,
  VALID_PRIORITIES
};
