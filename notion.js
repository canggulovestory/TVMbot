/**
 * notion.js — Notion CRUD for Tasks + Payments + Projects
 * Source of truth for all TVM data.
 */
'use strict';

const { Client } = require('@notionhq/client');

let notion;

function init() {
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN not set');
  notion = new Client({ auth: process.env.NOTION_TOKEN });
}

// ─── TASKS ──────────────────────────────────────────────────────────────────────

async function createTask({ name, priority = 'Mid', dueDate, projectId }) {
  const properties = {
    'Task Name': { title: [{ text: { content: name } }] },
    'Priority': { select: { name: priority } },
    'Completed': { checkbox: false },
  };
  if (dueDate) properties['Due Date'] = { date: { start: dueDate } };
  if (projectId) properties['Project'] = { relation: [{ id: projectId }] };

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_TASKS_DB },
    properties,
  });
  return { id: page.id, name, priority };
}

async function getTasks({ done = false, projectId } = {}) {
  const filters = [
    { property: 'Completed', checkbox: { equals: done } },
  ];
  if (projectId) filters.push({ property: 'Project', relation: { contains: projectId } });

  const response = await notion.databases.query({
    database_id: process.env.NOTION_TASKS_DB,
    filter: filters.length === 1 ? filters[0] : { and: filters },
    sorts: [
      { property: 'Priority', direction: 'ascending' },
      { property: 'Due Date', direction: 'ascending' },
    ],
    page_size: 100,
  });

  return response.results.map(page => {
    const p = page.properties;
    return {
      id: page.id,
      name: p['Task Name']?.title?.[0]?.plain_text || 'Untitled',
      priority: p['Priority']?.select?.name || 'Mid',
      done: p['Completed']?.checkbox || false,
      dueDate: p['Due Date']?.date?.start || null,
      projectIds: (p['Project']?.relation || []).map(r => r.id),
    };
  });
}

async function completeTask(searchText) {
  const tasks = await getTasks();
  const match = tasks.find(t =>
    t.name.toLowerCase().includes(searchText.toLowerCase())
  );
  if (!match) return null;

  await notion.pages.update({
    page_id: match.id,
    properties: { 'Completed': { checkbox: true } },
  });
  return match;
}

// ─── PROJECTS ───────────────────────────────────────────────────────────────────

async function getProjects() {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_PROJECTS_DB,
    page_size: 50,
  });
  return response.results.map(page => {
    const p = page.properties;
    return {
      id: page.id,
      name: p['Project Name']?.title?.[0]?.plain_text || 'Untitled',
      status: p['Project Status']?.select?.name || '',
      code: p['Project Code']?.rich_text?.[0]?.plain_text || '',
    };
  });
}

async function findProject(searchText) {
  const projects = await getProjects();
  return projects.find(p =>
    p.name.toLowerCase().includes(searchText.toLowerCase())
  );
}

// ─── PAYMENTS ───────────────────────────────────────────────────────────────────

async function createPayment({ villa, tenant, amount, dueDay, month, year, currency = 'IDR' }) {
  const properties = {
    'Villa': { title: [{ text: { content: villa } }] },
    'Status': { select: { name: 'Pending' } },
  };
  if (tenant) properties['Tenant'] = { rich_text: [{ text: { content: tenant } }] };
  if (amount) properties['Amount'] = { number: amount };
  if (dueDay) properties['Due Day'] = { number: dueDay };
  if (month) properties['Month'] = { rich_text: [{ text: { content: month } }] };
  if (year) properties['Year'] = { number: year };
  if (currency) properties['Currency'] = { select: { name: currency } };

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_PAYMENTS_DB },
    properties,
  });
  return { id: page.id, villa, status: 'Pending' };
}

async function getPayments({ status } = {}) {
  const query = { database_id: process.env.NOTION_PAYMENTS_DB, page_size: 100 };
  if (status) query.filter = { property: 'Status', select: { equals: status } };

  const response = await notion.databases.query(query);
  return response.results.map(page => {
    const p = page.properties;
    return {
      id: page.id,
      villa: p['Villa']?.title?.[0]?.plain_text || '',
      tenant: p['Tenant']?.rich_text?.[0]?.plain_text || '',
      amount: p['Amount']?.number || 0,
      dueDay: p['Due Day']?.number || 1,
      status: p['Status']?.select?.name || 'Pending',
      month: p['Month']?.rich_text?.[0]?.plain_text || '',
      year: p['Year']?.number || 0,
      currency: p['Currency']?.select?.name || 'IDR',
    };
  });
}

async function markPaid(villaSearch) {
  const payments = await getPayments({ status: 'Pending' });
  const match = payments.find(p =>
    p.villa.toLowerCase().includes(villaSearch.toLowerCase())
  );
  if (!match) return null;

  const today = new Date().toISOString().split('T')[0];
  await notion.pages.update({
    page_id: match.id,
    properties: {
      'Status': { select: { name: 'Paid' } },
      'Payment Date': { date: { start: today } },
    },
  });
  return match;
}

async function getPaymentsDueSoon(daysAhead = 3) {
  const now = new Date();
  const currentDay = now.getDate();
  const payments = await getPayments({ status: 'Pending' });

  const dueSoon = payments.filter(p => {
    const diff = p.dueDay - currentDay;
    return diff >= 0 && diff <= daysAhead;
  });
  const overdue = payments.filter(p => p.dueDay < currentDay);

  return { dueSoon, overdue };
}

module.exports = {
  init,
  createTask, getTasks, completeTask,
  getProjects, findProject,
  createPayment, getPayments, markPaid, getPaymentsDueSoon,
};
