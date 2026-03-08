const { Client } = require('@notionhq/client');
const config = require('../config/integrations.json');

function getClient() {
  if (!config.notion?.enabled || !config.notion?.api_key || config.notion.api_key === 'YOUR_NOTION_KEY') return null;
  return new Client({ auth: config.notion.api_key });
}

async function getPages() {
  const notion = getClient();
  if (!notion) return [];
  try {
    const res = await notion.search({ filter: { value: 'page', property: 'object' }, page_size: 10 });
    return res.results.map(p => ({
      id: p.id,
      title: p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || 'Untitled',
      url: p.url,
      lastEdited: p.last_edited_time
    }));
  } catch (err) { console.error('Notion pages error:', err.message); return []; }
}

async function createPage(parentId, title, content) {
  const notion = getClient();
  if (!notion) return null;
  try {
    const res = await notion.pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      children: content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content } }] } }] : []
    });
    return { id: res.id, url: res.url };
  } catch (err) { console.error('Notion create error:', err.message); return null; }
}

async function getDatabases() {
  const notion = getClient();
  if (!notion) return [];
  try {
    const res = await notion.search({ filter: { value: 'database', property: 'object' }, page_size: 10 });
    return res.results.map(d => ({
      id: d.id,
      title: d.title?.[0]?.plain_text || 'Untitled',
      url: d.url
    }));
  } catch (err) { console.error('Notion DB error:', err.message); return []; }
}

async function queryDatabase(databaseId) {
  const notion = getClient();
  if (!notion) return [];
  try {
    const res = await notion.databases.query({ database_id: databaseId });
    return res.results;
  } catch (err) { console.error('Notion query error:', err.message); return []; }
}

module.exports = { getPages, createPage, getDatabases, queryDatabase };
