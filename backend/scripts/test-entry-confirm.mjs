#!/usr/bin/env node
const BASE = 'http://localhost:4000/api';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* vacio */ }
  return { status: res.status, json };
}

async function main() {
  const T = (await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } })).json.token;
  const TE = (await api('POST', '/auth/login', { body: { username: 'encargado_smoke', password: 'encargado123' } })).json.token;
  
  // List entries
  const entries = await api('GET', '/entries', { token: T });
  console.log('Entries status:', entries.status);
  console.log('Entries:', JSON.stringify(entries.json?.entries?.slice(0,3) ?? entries.json));
  
  // Try confirming with encargado
  const eid = entries.json?.entries?.[0]?.id;
  if (eid) {
    const confirm = await api('POST', `/entries/${eid}/confirm`, { token: TE });
    console.log('Confirm with encargado:', confirm.status, JSON.stringify(confirm.json));
  }
  
  // Check encargado permissions
  const users = await api('GET', '/users', { token: T });
  const enc = users.json.users.find(u => u.username === 'encargado_smoke');
  console.log('Encargado user:', JSON.stringify(enc));
}

main().catch(e => { console.error(e); process.exit(1); });
