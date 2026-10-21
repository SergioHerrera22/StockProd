# Copias de seguridad y restauración

## Backup manual

```powershell
powershell -File scripts\backup.ps1
```

Genera `backups\robles_stock_YYYYMMDD_HHMMSS.dump` (formato custom de `pg_dump`, comprimido).

## Backup automático (recomendado: diario)

1. Abrí el **Programador de tareas** de Windows → *Crear tarea básica*.
2. Desencadenador: diariamente (ej. 23:00).
3. Acción: *Iniciar un programa*
   - Programa: `powershell`
   - Argumentos: `-ExecutionPolicy Bypass -File "C:\ruta\robles-stock-pro\scripts\backup.ps1"`
4. El script retiene automáticamente los últimos **30 días** y borra los más viejos.

> Copiá además la carpeta `backups\` a un disco externo o a la nube (OneDrive/Drive) una vez por semana.

## Ver el contenido de un backup

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --list backups\robles_stock_20260119_230000.dump
```

## Restauración completa

### Opción A — restaurar sobre la base existente (reemplaza todo)

```powershell
# 1. Cerrar la app (backend) para que no haya conexiones activas
# 2. Reconstruir la base
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -c "DROP DATABASE IF EXISTS robles_stock;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -c "CREATE DATABASE robles_stock OWNER robles_app;"

# 3. Restaurar el dump
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h localhost -U robles_app -d robles_stock --no-owner backups\robles_stock_20260119_230000.dump

# 4. Iniciar la app de nuevo
```

Si pide contraseña de `robles_app`, la encontrás en `backend\.env` (`DATABASE_URL`).

### Opción B — restaurar en otra computadora nueva

1. Instalá Node.js y PostgreSQL.
2. Copiá la carpeta del proyecto y el archivo `.dump` del backup.
3. `npm run db:setup` (crea rol, base y estructura).
4. Restaurá el dump como en la Opción A (paso 3).
5. `npm start`.

> La restauración devuelve **todo**: productos, saldos por ubicación, entregas,
> transferencias, inventarios, movimientos y usuarios.

## Verificación post-restauración

1. Ingresá con un usuario.
2. *Dashboard*: valores coherentes (productos, valor de inventario).
3. *Movimientos*: el historial llega hasta la fecha del backup.
4. *Stock*: saldos por ubicación presentes.
5. Creá una entrega de prueba en borrador y confirmala: debe descontar stock normalmente.
