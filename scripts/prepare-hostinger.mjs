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

// package.json del backend -> raiz, PERO ajustado para el servidor:
//  1) sin la dependencia circular "robles-stock-pro": "file:.." (rompe npm ci)
//  2) build = no-op (el ZIP ya viene compilado; tsc en la raiz no halla
//     tsconfig.json y el builder de Hostinger fallaba)
writeServerPackage();
console.log('✓ package.json copiado a raíz (limpio para despliegue)');

function writeServerPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'backend', 'package.json'), 'utf8'));
  delete pkg.dependencies['robles-stock-pro'];
  // El server nunca ejecuta herramientas de desarrollo. Solo tsx (y su
  // dependencia esbuild con postinstall) esta en devDependencies, pero el
  // builder de Hostinger con pnpm FALLA si esbuild no tiene aprobado su
  // postinstall (ERR_PNPM_IGNORED_BUILDS). Sin devDeps el install es limpio.
  delete pkg.devDependencies;
  // Blindaje por si algo transitive vuelve a traer postinstalls: pnpm los
  // ignora explicitamente en lugar de fallar el build.
  pkg.pnpm = { ignoredBuiltDependencies: ['esbuild'] };
  pkg.scripts.build = 'node -e "console.log(\'OK: el paquete ya viene compilado en dist/ (no compilar en servidor)\')"';
  pkg.scripts.start = 'node dist/index.js';
  // Entry point para builders que leen "main" del package.json
  pkg.main = 'dist/index.js';
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // package-lock: quitar tambien el paquete "link" generado por el file: dep
  // y las herramientas de dev (tsx/esbuild) para que quede sincronizado con
  // el package.json sin devDependencies (npm ci exige consistencia total).
  const lockPath = path.join(rootDir, 'backend', 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.packages) {
      delete lock.packages[''].dependencies?.['robles-stock-pro'];
      delete lock.packages['node_modules/robles-stock-pro'];
      delete lock.packages[''].devDependencies;
      delete lock.packages['node_modules/tsx'];
      delete lock.packages['node_modules/esbuild'];
    }
    if (lock.dependencies) {
      delete lock.dependencies['robles-stock-pro'];
      delete lock.dependencies.tsx;
    }
    if (lock.devDependencies) delete lock.devDependencies.tsx;
    fs.writeFileSync(path.join(rootDir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  }
}

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