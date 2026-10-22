#!/usr/bin/env node
/** Prepara estructura para Hostinger: backend en dist/, frontend en public/ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const backendDist = path.join(rootDir, 'backend', 'dist');
const frontendDist = path.join(rootDir, 'frontend', 'dist');
const rootDist = path.join(rootDir, 'dist');
const rootPublic = path.join(rootDir, 'public');

// Limpiar directorios previos
for (const dir of [rootDist, rootPublic]) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

// Copiar backend/dist -> dist/
copyRecursive(backendDist, rootDist);
console.log('✓ Backend copiado a dist/');

// Copiar frontend/dist -> public/
copyRecursive(frontendDist, rootPublic);
console.log('✓ Frontend copiado a public/');

// Copiar package.json y package-lock.json del backend a raíz
fs.copyFileSync(
  path.join(rootDir, 'backend', 'package.json'),
  path.join(rootDir, 'package.json')
);
fs.copyFileSync(
  path.join(rootDir, 'backend', 'package-lock.json'),
  path.join(rootDir, 'package-lock.json')
);
console.log('✓ package.json copiado a raíz');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`⚠ Origen no existe: ${src}`);
    return;
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('\n✅ Estructura lista para Hostinger:');
console.log('  dist/index.js          (entry point)');
console.log('  public/index.html      (frontend)');