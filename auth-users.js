/**
 * auth-users.js — Multi-user accounts with roles.
 * Passwords: scrypt (salt:hash). Roles: 'admin' | 'staff'.
 * Seeds the first admin from ADMIN_USERNAME/ADMIN_PASSWORD env on first boot.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

let filePath;
let writeQueue = Promise.resolve();
let cache = null;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyHash(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function read() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    cache = { users: [] };
  }
  return cache;
}

function mutate(work) {
  const task = writeQueue.then(async () => {
    const store = await read();
    const result = await work(store);
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(temp, filePath);
    return result;
  });
  writeQueue = task.catch(() => {});
  return task;
}

async function init(dataDir) {
  filePath = path.join(dataDir, 'users.json');
  const store = await read();
  if (store.users.length === 0) {
    const seedUser = (process.env.ADMIN_USERNAME || 'afni').toLowerCase();
    const seedPassword = process.env.ADMIN_PASSWORD;
    if (seedPassword) {
      await mutate(s => {
        s.users.push({
          username: seedUser, name: 'Afni', role: 'admin',
          passwordHash: hashPassword(seedPassword),
          createdAt: new Date().toISOString(),
        });
      });
      console.log(`[Auth] Seeded first admin "${seedUser}" from environment`);
    }
  }
}

async function verify(username, password) {
  const store = await read();
  const user = store.users.find(u => u.username === String(username || '').toLowerCase());
  if (!user || !verifyHash(password, user.passwordHash)) return null;
  return { username: user.username, name: user.name, role: user.role };
}

async function exists(username) {
  const store = await read();
  return store.users.some(u => u.username === String(username || '').toLowerCase());
}

async function listUsers() {
  const store = await read();
  return store.users.map(({ passwordHash, ...u }) => u);
}

async function addUser({ username, name, password, role }) {
  username = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Error('Username: 3-30 chars, letters/numbers/._- only.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  if (!['admin', 'staff'].includes(role)) role = 'staff';
  return mutate(store => {
    if (store.users.some(u => u.username === username)) throw new Error('Username already exists.');
    const user = {
      username, name: String(name || username).slice(0, 80), role,
      passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    const { passwordHash, ...safe } = user;
    return safe;
  });
}

async function removeUser(username) {
  username = String(username || '').toLowerCase();
  return mutate(store => {
    const target = store.users.find(u => u.username === username);
    if (!target) return null;
    const admins = store.users.filter(u => u.role === 'admin');
    if (target.role === 'admin' && admins.length <= 1) throw new Error('Cannot remove the last admin.');
    store.users = store.users.filter(u => u.username !== username);
    return { username };
  });
}

async function changePassword(username, newPassword) {
  if (String(newPassword || '').length < 8) throw new Error('Password must be at least 8 characters.');
  username = String(username || '').toLowerCase();
  return mutate(store => {
    const user = store.users.find(u => u.username === username);
    if (!user) throw new Error('User not found.');
    user.passwordHash = hashPassword(newPassword);
    return { username };
  });
}

module.exports = { init, verify, exists, listUsers, addUser, removeUser, changePassword };
