#!/usr/bin/env bash
# Restaura um backup feito por scripts/backup.sh. SUBSTITUI o banco e as mídias atuais.
# Uso: ./scripts/restore.sh backups/AAAAMMDD-HHMMSS [--sim]
#   --sim  não pede confirmação (para automação)
#
# Pré-requisito: o .env em uso deve ter a MESMA ENCRYPTION_KEY da época do backup;
# com outra chave, os dados restauram, mas todos os números precisam ler o QR de novo.
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:?informe a pasta do backup, ex.: backups/20261114-030000}"
[[ -f "$src/banco.dump" ]] || { echo "Não encontrei $src/banco.dump" >&2; exit 1; }

if [[ "${2:-}" != "--sim" ]]; then
  read -r -p "Isto apaga o banco e as mídias atuais e restaura $src. Digite RESTAURAR para continuar: " answer
  [[ "$answer" == "RESTAURAR" ]] || { echo "Cancelado."; exit 1; }
fi

echo "Parando API e worker…"
docker compose stop api worker

echo "Restaurando o banco…"
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$src/banco.dump"

if [[ -f "$src/midia.tar.gz" ]]; then
  echo "Restaurando as mídias…"
  docker compose run --rm --no-deps -T --entrypoint sh api -c 'find /data/media -mindepth 1 -delete && tar -C /data/media -xzf -' < "$src/midia.tar.gz"
fi

echo "Aplicando migrations (caso o backup seja de uma versão anterior) e subindo…"
docker compose run --rm migrate
docker compose up -d api worker

# Só declara concluído quando a API responde (o painel dá erro 502 enquanto ela sobe).
echo "Aguardando a API…"
for _ in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "Restauração concluída."
    exit 0
  fi
  sleep 2
done
echo "A API não respondeu em 2 minutos. Veja: docker compose logs api" >&2
exit 1
