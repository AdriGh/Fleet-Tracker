#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Backup de la base Postgres de Fleet Tracker  (OPS-3, ver docs/AUDITORIA.md)
# ---------------------------------------------------------------------------
# Pensado para correr por CRON en el VPS. Hace pg_dump DENTRO del contenedor
# de la base (usa sus propias env POSTGRES_*; no hace falta saber la clave en
# el host), comprime con timestamp y poda los backups viejos.
#
# Instalar en el VPS (una vez):
#   mkdir -p /root/fleet-backups
#   cp ops/backup.sh /root/fleet-backups/backup.sh   # o pegarlo a mano
#   chmod +x /root/fleet-backups/backup.sh
#   # cron diario 03:00:
#   (crontab -l 2>/dev/null; echo '0 3 * * * /root/fleet-backups/backup.sh >> /root/fleet-backups/backup.log 2>&1') | crontab -
#
# Probar a mano:  /root/fleet-backups/backup.sh
# Restaurar:      ver ops/db-restore.md
# ---------------------------------------------------------------------------
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-fleet-tracker-fleettracker-pov0zh-db-1}"
BACKUP_DIR="${BACKUP_DIR:-/root/fleet-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/fleet-$STAMP.sql.gz"

# pg_dump corre DENTRO del contenedor con sus propias credenciales (env del
# contenedor). -h 127.0.0.1 fuerza TCP para que use PGPASSWORD.
docker exec "$DB_CONTAINER" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "$OUT"

# Falla ruidoso si el dump quedó vacío (no dejar un backup inútil).
if [ ! -s "$OUT" ]; then
  echo "ERROR: backup vacío, lo borro: $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

# Poda backups más viejos que RETENTION_DAYS.
find "$BACKUP_DIR" -name 'fleet-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "$(date '+%F %T') OK backup -> $OUT ($(du -h "$OUT" | cut -f1))"

# NOTA (mejora futura): copiar $OUT fuera del VPS (rclone a S3/Backblaze/Drive)
# para sobrevivir a la pérdida del servidor. Hoy el backup es LOCAL al VPS.
