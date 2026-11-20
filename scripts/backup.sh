#!/usr/bin/env bash
# Backup do banco e das mídias locais.
# Uso: ./scripts/backup.sh [pasta_destino]        (padrão: ./backups)
# Agende no cron, por exemplo, todo dia às 3h:
#   0 3 * * * cd /opt/newsales && mkdir -p backups && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# O .env NÃO entra no backup de propósito: ele tem a ENCRYPTION_KEY, e quem tiver
# banco + chave consegue usar as sessões do WhatsApp. Guarde o .env em outro lugar.
set -euo pipefail
cd "$(dirname "$0")/.."

root="${1:-backups}"
keep_days="${KEEP_DAYS:-14}"
dest="$root/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$dest"

echo "Banco → $dest/banco.dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dest/banco.dump"

driver=$(grep -E '^STORAGE_DRIVER=' .env 2>/dev/null | cut -d= -f2 || true)
if [[ "${driver:-local}" == "local" ]]; then
  echo "Mídias → $dest/midia.tar.gz"
  docker compose exec -T api tar -C /data/media -czf - . > "$dest/midia.tar.gz"
else
  echo "Mídias no S3/MinIO: use o versionamento ou a replicação do próprio bucket."
fi

# Confere que o dump é legível antes de considerar o backup bom.
docker compose exec -T postgres pg_restore --list < "$dest/banco.dump" > /dev/null
echo "Backup concluído: $(du -sh "$dest" | cut -f1)"

if [[ "$keep_days" =~ ^[0-9]+$ && "$keep_days" -gt 0 ]]; then
  find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +"$keep_days" -exec rm -rf {} +
fi
