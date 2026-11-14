# NewSales WhatsApp

Painel self-hosted de disparo e atendimento via WhatsApp: até 10 números conectados por QR Code (Baileys), caixa de entrada unificada com espelhamento das conversas, campanhas com proteções anti-banimento e automação de respostas.

> **Atenção:** o sistema usa uma conexão não oficial. Disparo em massa por esse meio viola os Termos de Serviço do WhatsApp e pode levar ao banimento dos números. Envie apenas para contatos que deram consentimento (LGPD).

## Andamento

| Fase | Conteúdo | Situação |
|---|---|---|
| 1 | Arquitetura, modelo de dados, estrutura de pastas | concluída — [docs/01-arquitetura.md](docs/01-arquitetura.md) |
| 2 | Sessões múltiplas, QR Code, espelhamento | concluída — [docs/02-sessoes-e-espelhamento.md](docs/02-sessoes-e-espelhamento.md) |
| 3 | Caixa de entrada unificada | concluída — [docs/03-caixa-de-entrada.md](docs/03-caixa-de-entrada.md) |
| 4 | Contatos, listas, campanhas, anti-banimento | concluída — [docs/04-contatos-e-campanhas.md](docs/04-contatos-e-campanhas.md) |
| 5 | Automações, usuários, dashboard | pendente |
| 6 | Docker Compose, instalação, operação | pendente |

## Rodando em desenvolvimento

Requisitos: Node.js 20.11+, PostgreSQL 16 e Redis 7 acessíveis.

```bash
cp .env.example .env        # preencha JWT_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD e aponte DATABASE_URL/REDIS_URL para localhost
npm install
npm run db:migrate          # cria as tabelas
npm run db:seed             # cria o primeiro administrador
npm run dev:api             # API em http://localhost:4000
npm run dev:worker          # sessões WhatsApp e filas (rode uma única instância)
npm run dev:web             # painel em http://localhost:3000
npm test -w apps/api        # testes de integração (gravam e apagam dados no banco do .env: use um banco de desenvolvimento)
```

A instalação com Docker Compose entra na fase 6.
