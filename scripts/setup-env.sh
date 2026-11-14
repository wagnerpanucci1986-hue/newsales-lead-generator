#!/usr/bin/env bash
# Cria o .env a partir do .env.example, gerando os segredos.
# Uso: ./scripts/setup-env.sh [dominio]      ex.: ./scripts/setup-env.sh whats.suaempresa.com.br
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  echo "Já existe um .env. Para não sobrescrever segredos em uso (o que derrubaria as sessões), nada foi alterado." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl não encontrado" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }
admin_password=$(hex 9)

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$(hex 32)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(hex 32)|" \
  -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${admin_password}|" \
  .env.example > .env

if [[ $# -ge 1 && -n "$1" ]]; then
  sed -i.bak -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$1|" -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$1|" .env && rm -f .env.bak
fi
chmod 600 .env

echo ".env criado."
echo "Administrador inicial: $(grep '^ADMIN_EMAIL=' .env | cut -d= -f2)  senha: ${admin_password}"
echo "Ajuste ADMIN_EMAIL no .env se quiser, e guarde uma cópia do .env em local seguro (contém a ENCRYPTION_KEY)."
