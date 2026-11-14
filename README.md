# NewSales WhatsApp

Painel self-hosted de disparo e atendimento via WhatsApp: até 10 números conectados por QR Code (Baileys), caixa de entrada unificada com espelhamento das conversas, campanhas com proteções anti-banimento, respostas automáticas, usuários com perfis e 2FA, e dashboard.

> **Leia antes de usar.** O sistema usa uma conexão **não oficial** com o WhatsApp. Disparo em massa por esse meio viola os Termos de Serviço do WhatsApp e pode levar ao **banimento dos números**, sem aviso e sem recurso. As proteções reduzem o risco, não o eliminam. Use chips dedicados, nunca o número principal da empresa, e envie **somente para contatos que deram consentimento** (LGPD).

## Documentação

| Documento | Conteúdo |
|---|---|
| [Instalação](#instalação) (abaixo) | Subir em um servidor com Docker Compose |
| [docs/06-operacao.md](docs/06-operacao.md) | Boas práticas de uso, backup, atualização, monitoramento e solução de problemas |
| [docs/01-arquitetura.md](docs/01-arquitetura.md) | Arquitetura, modelo de dados, estrutura de pastas |
| [docs/02](docs/02-sessoes-e-espelhamento.md) a [docs/05](docs/05-automacoes-usuarios-dashboard.md) | O que cada fase entregou, como foi verificado e limitações |

## Componentes

```
Internet ──▶ caddy (80/443, HTTPS automático)
               ├─ /api, /socket.io ──▶ api      (Fastify + Socket.IO)
               └─ demais rotas ──────▶ web      (painel Next.js)
             worker  (sessões WhatsApp, disparos, filas — 1 réplica)
             migrate (aplica migrations e cria o 1º admin a cada subida)
             postgres · redis
```

Só o Caddy expõe portas. Banco, Redis, API e worker ficam na rede interna do Docker.

## Instalação

### 1. Servidor

- Linux com **Docker Engine 24+** e o plugin **Docker Compose v2** ([instalação oficial](https://docs.docker.com/engine/install/)).
- Mínimo: **2 vCPU, 4 GB de RAM, 40 GB de disco** para 10 números. A mídia espelhada cresce com o uso; acompanhe o disco.
- Portas **80 e 443** liberadas no firewall. Todas as outras podem ficar fechadas.
- Para HTTPS: um domínio ou subdomínio (ex.: `whats.suaempresa.com.br`) com registro DNS **A** apontando para o IP do servidor, **antes** de subir.
- O servidor precisa de saída para a internet (WhatsApp e Let's Encrypt).

### 2. Código e configuração

```bash
git clone <url-do-repositorio> /opt/newsales
cd /opt/newsales
./scripts/setup-env.sh whats.suaempresa.com.br   # sem domínio: ./scripts/setup-env.sh
```

O script cria o `.env` com senhas e chaves aleatórias e mostra a senha do administrador inicial. Depois:

1. Abra o `.env` e ajuste `ADMIN_EMAIL` para o seu e-mail.
2. **Guarde uma cópia do `.env` fora do servidor** (gerenciador de senhas, cofre). Ele tem a `ENCRYPTION_KEY`: sem ela, nenhuma sessão de WhatsApp pode ser recuperada de um backup.

As demais opções estão comentadas no próprio `.env` (fuso, limites de upload, histórico, armazenamento S3).

### 3. Subir

```bash
docker compose up -d --build
docker compose ps          # api "healthy", migrate "exited (0)", demais "running"
docker compose logs -f worker
```

A primeira construção leva alguns minutos. Depois acesse `https://whats.suaempresa.com.br` (ou `http://IP-do-servidor` sem domínio) e entre com o administrador.

Com domínio, o certificado é emitido na primeira requisição; se falhar, veja `docker compose logs caddy` (quase sempre DNS ainda não propagado ou porta 80 bloqueada).

### 4. Primeiros passos no painel

1. **Minha conta** (clique no seu nome): ative a **verificação em duas etapas**.
2. **Números**: adicione um número e leia o QR Code em *WhatsApp > Dispositivos conectados > Conectar dispositivo*. Comece por um chip de teste.
3. Confira se as conversas aparecem em **Conversas** e responda uma pelo painel.
4. **Usuários**: crie os atendentes e marque os números de cada um.
5. **Configurações**: revise as palavras de descadastro e os parâmetros de anti-banimento.
6. **Automações**: defina o horário de atendimento e as respostas automáticas.
7. Só então importe contatos e faça uma **campanha pequena** de teste. Leia [docs/06-operacao.md](docs/06-operacao.md) antes da primeira campanha real.

Depois do primeiro login, você pode apagar o valor de `ADMIN_PASSWORD` do `.env`: o administrador só é criado quando não existe nenhum.

### 5. Backup

```bash
mkdir -p backups && ./scripts/backup.sh          # banco + mídias em backups/AAAAMMDD-HHMMSS
./scripts/restore.sh backups/AAAAMMDD-HHMMSS     # restaura (pede confirmação)
```

Agende o backup no cron e copie a pasta `backups/` para fora do servidor. Detalhes em [docs/06-operacao.md](docs/06-operacao.md#backup-e-restauração).

## Desenvolvimento

Requisitos: Node.js 22, PostgreSQL 16 e Redis 7 locais.

```bash
cp .env.example .env     # descomente DATABASE_URL, REDIS_URL e STORAGE_LOCAL_PATH no fim do arquivo
                         # e preencha JWT_SECRET, ENCRYPTION_KEY, ADMIN_EMAIL e ADMIN_PASSWORD
npm install
npm run db:migrate       # cria as tabelas
npm run db:seed          # cria o primeiro administrador
npm run dev:api          # API em http://localhost:4000
npm run dev:worker       # sessões e filas (uma única instância)
npm run dev:web          # painel em http://localhost:3000
npm test -w apps/api     # testes de integração — gravam e apagam dados: use um banco de desenvolvimento
```

Em desenvolvimento o painel fala com a API pela URL de `apps/web/.env.development`; em produção, pela mesma origem, via Caddy.

O CI (`.github/workflows/ci.yml`) roda os testes e o build a cada pull request, e sobe o `docker compose` completo com teste de login, worker e backup/restauração.
