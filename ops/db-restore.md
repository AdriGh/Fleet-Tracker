# Restaurar la base Postgres de Fleet Tracker (OPS-3)

Los backups los genera `ops/backup.sh` (cron en el VPS) en `/root/fleet-backups/`
como `fleet-YYYYMMDD-HHMMSS.sql.gz`.

## Restaurar un backup

> ⚠️ Esto **sobrescribe** los datos actuales de la base. Hacé un backup fresco
> antes por las dudas (`/root/fleet-backups/backup.sh`).

Por SSH en el VPS:

```bash
DB=fleet-tracker-fleettracker-pov0zh-db-1
BACKUP=/root/fleet-backups/fleet-YYYYMMDD-HHMMSS.sql.gz   # <- el que quieras

# (opcional pero recomendado) parar la app para que no escriba durante el restore
# docker stop fleet-tracker-fleettracker-pov0zh-app-1

gunzip < "$BACKUP" | docker exec -i "$DB" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# docker start fleet-tracker-fleettracker-pov0zh-app-1
```

## Verificar un backup sin restaurar

```bash
gunzip < /root/fleet-backups/fleet-XXXX.sql.gz | head -40   # debe verse SQL (CREATE TABLE, COPY...)
```

## Notas
- El `pg_dump` es un dump lógico (SQL); restaura en cualquier Postgres 16.
- Para una restauración a una base **vacía/nueva** conviene `pg_restore`/`psql`
  sobre una DB recién creada; el dump por defecto incluye los datos.
- Mejora pendiente: copiar los backups **fuera del VPS** (rclone a S3/Backblaze)
  y probar el restore periódicamente (un backup no verificado no es un backup).
