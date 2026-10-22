#!/usr/bin/env node
/**
 * Script de despliegue manual a Hostinger via FTP
 * Uso: node scripts/deploy-hostinger.mjs
 * Requiere: HOSTINGER_FTP_HOST, HOSTINGER_FTP_USER, HOSTINGER_FTP_PASSWORD, HOSTINGER_FTP_DIR como variables de entorno
 */

import ftp from 'basic-ftp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const requiredEnv = [
  'HOSTINGER_FTP_HOST',
  'HOSTINGER_FTP_USER',
  'HOSTINGER_FTP_PASSWORD',
  'HOSTINGER_FTP_DIR'
];

for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`❌ Falta variable de entorno: ${env}`);
    process.exit(1);
  }
}

const client = new ftp.Client();
client.ftp.verbose = false;

async function deploy() {
  try {
    console.log('🔌 Conectando a Hostinger FTP...');
    await client.access({
      host: process.env.HOSTINGER_FTP_HOST,
      user: process.env.HOSTINGER_FTP_USER,
      password: process.env.HOSTINGER_FTP_PASSWORD,
      secure: false, // FTP normal, usa true para FTPS
    });

    console.log(`📂 Cambiando a directorio: ${process.env.HOSTINGER_FTP_DIR}`);
    await client.ensureDir(process.env.HOSTINGER_FTP_DIR);
    await client.cd(process.env.HOSTINGER_FTP_DIR);

    // Archivos y carpetas a subir
    const uploads = [
      { local: 'backend/dist', remote: 'backend/dist' },
      { local: 'frontend/dist', remote: 'frontend/dist' },
      { local: 'backend/package.json', remote: 'backend/package.json' },
      { local: 'backend/package-lock.json', remote: 'backend/package-lock.json' },
      { local: 'backend/.env', remote: 'backend/.env' },
      { local: 'frontend/.env', remote: 'frontend/.env' },
    ];

    for (const { local, remote } of uploads) {
      const localPath = path.join(projectRoot, local);
      if (!fs.existsSync(localPath)) {
        console.log(`⚠️  No existe: ${local} (saltando)`);
        continue;
      }

      const stat = fs.statSync(localPath);
      if (stat.isDirectory()) {
        console.log(`📁 Subiendo directorio: ${local} → ${remote}`);
        await client.ensureDir(remote);
        await client.uploadFromDir(localPath, remote);
      } else {
        console.log(`📄 Subiendo archivo: ${local} → ${remote}`);
        await client.uploadFrom(localPath, remote);
      }
    }

    console.log('✅ Despliegue completado exitosamente');
    console.log('🔄 Recuerda reiniciar la app en Hostinger (PM2, systemctl, o panel)');
  } catch (err) {
    console.error('❌ Error en despliegue:', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

deploy();