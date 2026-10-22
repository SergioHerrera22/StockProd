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

const stamp = Date.now();
const prodBody = {
  code: `SMK-${stamp}`,
  barcode: `77${stamp}`.slice(0, 13),
  name: `Pintura Smoke Test ${stamp}`,
  brand: 'TestBrand',
  unit: 'UNIDAD',
  minStock: 5,
  cost: 1000,
};

// Login
const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
console.log('Login status:', login.status, 'token:', login.json.token ? 'sí' : 'no');
const T = login.json.token;

// Crear producto
const created = await api('POST', '/products', { token: T, body: prodBody });
console.log('Create status:', created.status, 'json:', JSON.stringify(created.json));
const pid = created.json?.id;

// Duplicado
const dup = await api('POST', '/products', { token: T, body: prodBody });
console.log('Dup status:', dup.status, 'json:', JSON.stringify(dup.json));

// Detalle
const prodDetail = await api('GET', `/products/${pid}`, { token: T });
console.log('Detail status:', prodDetail.status, 'json:', JSON.stringify(prodDetail.json));

// Stock
const stock = await api('GET', `/products/${pid}`, { token: T });
console.log('Stock length:', stock.json?.stock?.length);
console.log('Stock:', JSON.stringify(stock.json?.stock));
