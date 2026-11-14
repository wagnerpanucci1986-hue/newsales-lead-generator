# Fase 6 — Operação

Guia para quem vai manter o sistema no ar e usar os disparos no dia a dia. A instalação está no [README](../README.md#instalação).

## 1. Boas práticas para não perder números

Nenhuma configuração torna o disparo por conexão não oficial seguro. O WhatsApp não publica limites, muda os critérios sem aviso e bane sem recurso. As práticas abaixo reduzem os sinais que mais levam a banimento; o que mais pesa, porém, é **quem recebe e o que recebe**.

**Chips**
- Use chips **dedicados** ao sistema. Nunca o número principal da empresa ou de uma pessoa.
- Prefira chips com algum tempo de uso real (conversas de ida e volta, grupos, foto e nome no perfil) antes do primeiro disparo.
- Configure nome, foto e, se for WhatsApp Business, o perfil comercial completo. Contas vazias são mais suspeitas.
- Tenha chips de reserva. Planeje a operação contando que algum número será perdido.

**Volume**
- Mantenha o **aquecimento ligado** em todo chip novo. Com os padrões, o número começa em 20 disparos por dia e chega a 200 em cerca de 12 dias.
- Não suba o limite diário de um número que acabou de ser pausado ou que está com entrega baixa.
- Distribua as campanhas entre vários números em vez de concentrar o volume em um só.
- Não reduza os intervalos abaixo dos padrões (15–60 s, pausa longa de 5–15 min a cada 20) sem um motivo medido.

**Conteúdo**
- Use **spintax e variáveis** em todas as campanhas, para que as mensagens não saiam idênticas.
- Evite encurtadores de link e links para domínios novos. Prefira o domínio da empresa.
- Mensagem curta, com identificação de quem envia e um motivo claro. Diga como sair ("responda SAIR para não receber mais").
- Evite enviar anexo na primeira mensagem para quem nunca falou com o número.

**Base de contatos**
- Envie **somente** para quem autorizou e registre a origem do consentimento na importação. Denúncias de quem não pediu a mensagem são a principal causa de banimento.
- Rode a **verificação de WhatsApp** antes das campanhas, usando um número que não esteja disparando.
- Nunca remova alguém da lista de bloqueio sem pedido da própria pessoa.
- Bases antigas ou compradas têm alta taxa de denúncia: não use.

**Sinais de alerta**

| Sinal no painel | O que fazer |
|---|---|
| Número **Suspeito — pausado** | Leia o motivo. Pare as campanhas desse número por 24–48 h; use-o só para atendimento. Ao liberar, reduza o limite diário. |
| Taxa de entrega caindo no relatório | Mensagens aceitas e não entregues indicam restrição. Pause e reduza volume. |
| Taxa de resposta muito baixa ou muitos descadastros | A base ou a mensagem não interessa. Revise antes de continuar. |
| Número **Banido** | Não reconecte repetidamente. Tire-o das campanhas e substitua o chip. |
| Desconexões frequentes do mesmo número | Veja a seção de solução de problemas; pode ser o celular sem internet ou sessão aberta em outro lugar. |

## 2. LGPD na prática

- **Base legal:** para mensagens de divulgação, o caminho seguro é o consentimento. Guarde a prova (formulário, data, texto aceito) fora deste sistema; aqui fica só a origem.
- **Descadastro:** funciona sozinho pelas palavras configuradas. Atendentes devem bloquear manualmente quem pedir para sair com outras palavras ("não quero mais", "me tira daí").
- **Retenção:** o sistema guarda todas as conversas e mídias indefinidamente. Defina uma política (por exemplo, apagar contatos inativos há 2 anos) e aplique periodicamente.
- **Pedido de exclusão de um titular:** excluir o contato em Contatos remove o cadastro, mas as conversas espelhadas continuam. Hoje a exclusão completa exige remover a conversa no banco (ver seção 7).
- **Acesso:** dê a cada pessoa o menor perfil necessário e marque só os números que ela atende. O log de auditoria registra quem fez o quê.

## 3. Rotina

**Diária**
- Abra a **Visão geral**: todos os números conectados? Algum alerta de pausa? Falhas no dia?
- Veja o progresso das campanhas ativas e a taxa de entrega.
- Atenda a fila **Pendente** (conversas encaminhadas pela automação).

**Semanal**
- Confira que os backups estão sendo gerados e copiados para fora do servidor.
- Espaço em disco: `df -h` e `docker system df`.
- Revise o log de auditoria (Usuários > Log de auditoria) em busca de acessos estranhos.
- Remova usuários de quem saiu da equipe (desativar encerra as sessões na hora).

**Mensal**
- **Teste de restauração** do backup em outra máquina (seção 5). Backup que nunca foi restaurado não é confiável.
- Atualizações do sistema operacional e do sistema (seção 6).

## 4. Monitoramento e logs

```bash
docker compose ps                         # estado e healthcheck de cada serviço
docker compose logs -f worker             # sessões, disparos, pausas automáticas
docker compose logs -f api                # requisições e erros da API
docker compose logs --since 1h caddy      # acessos e certificado HTTPS
docker compose exec api node -e "fetch('http://localhost:4000/health').then(r=>r.text()).then(console.log)"
```

O `/health` responde `{"ok":true,"worker":true}`; `worker:false` significa que nenhum worker está ativo, e portanto nenhum número está conectado.

Os logs ficam em JSON, com rotação automática de 5 arquivos de 20 MB por serviço. Para monitorar de fora, configure um serviço de *uptime* (UptimeRobot, Better Stack ou similar) checando `https://SEU-DOMINIO/login` a cada 5 minutos.

Mensagens do worker que merecem atenção:

| Mensagem | Significado |
|---|---|
| `número pausado automaticamente` | Falhas em sequência ou queda de entrega. |
| `conexão com o WhatsApp fechada` com `code: 401` | O aparelho foi desvinculado pelo celular; é preciso ler o QR de novo. |
| `code: 403` | O WhatsApp recusou a conta (banida ou restrita). |
| `code: 440` | A sessão foi aberta em outro lugar (outro servidor com o mesmo backup, por exemplo). |
| `code: 405` | Versão do WhatsApp Web recusada: atualize o Baileys (seção 6). |
| `já existe um worker ativo; aguardando em espera` | Há um segundo worker rodando. Normal só durante uma atualização. |

## 5. Backup e restauração

| O quê | Onde | Como |
|---|---|---|
| Banco (conversas, contatos, campanhas, credenciais cifradas das sessões) | volume `pgdata` | `./scripts/backup.sh` (dump do PostgreSQL) |
| Mídias recebidas e enviadas | volume `media` (ou bucket S3) | `./scripts/backup.sh` (tar), ou versionamento do bucket |
| `.env` (com a `ENCRYPTION_KEY`) | servidor | **cópia manual, guardada separada dos backups** |
| Filas do Redis | volume `redisdata` | não precisa: o estado durável está no banco |

```bash
mkdir -p backups
./scripts/backup.sh                    # cria backups/AAAAMMDD-HHMMSS (apaga os com mais de 14 dias)
KEEP_DAYS=30 ./scripts/backup.sh       # outra retenção
```

Agende no cron (`crontab -e`):

```
0 3 * * * cd /opt/newsales && mkdir -p backups && ./scripts/backup.sh >> backups/backup.log 2>&1
```

E copie `backups/` para fora do servidor (rclone, rsync, snapshot do provedor). Um backup que só existe no mesmo disco não protege contra a perda do servidor.

**Por que o `.env` fica separado:** quem tiver o dump do banco **e** a `ENCRYPTION_KEY` consegue usar as sessões do WhatsApp de todos os números. Separados, um vazamento de backup não basta.

**Restaurar** (substitui banco e mídias atuais, pede confirmação):

```bash
./scripts/restore.sh backups/20261114-030000
```

**Migrar para outro servidor:** instale o sistema no novo servidor com o **mesmo `.env`**, rode `restore.sh` com o backup mais recente e só então desligue o servidor antigo. Nunca deixe os dois com o worker ligado ao mesmo tempo: as sessões se derrubam (erro 440) e o WhatsApp pode tratar isso como comportamento suspeito.

## 6. Atualização

```bash
cd /opt/newsales
./scripts/backup.sh                    # sempre antes
git pull
docker compose up -d --build           # migrations rodam sozinhas no serviço "migrate"
docker compose ps
```

O worker leva até 30 s para fechar as sessões e o novo assume em seguida; os números reconectam sozinhos, sem QR. Mensagens recebidas nesse intervalo chegam na reconexão.

**Biblioteca do WhatsApp (Baileys).** A versão fica fixada em `apps/api/package.json`. Atualize quando:
- os números passarem a desconectar com `code: 405`, ou
- uma versão nova corrigir um problema que você está vendo.

Procedimento: altere a versão, rode os testes (`npm test -w apps/api`), suba primeiro em um ambiente com um chip de teste, observe conexão, envio e recebimento por algumas horas e só então atualize a produção.

**Voltar uma versão:** `git checkout <versão anterior>` e `docker compose up -d --build`. Se a versão nova tiver aplicado uma migration, restaure também o backup feito antes da atualização.

## 7. Segurança

- [ ] **2FA** ativo para todos os administradores e gestores.
- [ ] Firewall com só 22 (de preferência restrita ao seu IP), 80 e 443 abertas.
- [ ] SSH por chave, sem senha; usuário root sem login remoto.
- [ ] `.env` com permissão `600` (o `setup-env.sh` já faz) e cópia guardada em cofre.
- [ ] Nenhuma porta de banco, Redis ou API publicada no `docker-compose.yml`.
- [ ] Sistema operacional e Docker atualizados mensalmente.
- [ ] Usuários desativados quando a pessoa sai da equipe.

**Trocar segredos**

| Segredo | Efeito de trocar |
|---|---|
| `JWT_SECRET` | Todos os usuários precisam entrar de novo; links de mídia abertos param de funcionar. Sem perda de dados. |
| `POSTGRES_PASSWORD` | Precisa alterar também dentro do banco (`ALTER USER`) antes de reiniciar; senão a API não conecta. |
| `ENCRYPTION_KEY` | **Não há rotação.** Trocar invalida todas as sessões (todos os números leem o QR de novo) e os 2FA cadastrados. Só faça se a chave vazou. |

**Acesso direto ao banco** (para manutenção, sem expor a porta):

```bash
docker compose exec postgres psql -U newsales newsales
```

## 8. Capacidade

- Feito para **até 10 números** em um único servidor. Cada sessão usa em média 50–100 MB de RAM no worker.
- O worker é **um só** (trava de líder no Redis). Não escale com `--scale worker=2`: o segundo fica em espera.
- A mídia é o que mais cresce. Acompanhe o volume `media` (`docker system df -v`) ou use `STORAGE_DRIVER=s3` com um bucket.
- Contas com histórico muito grande levam vários minutos para espelhar no primeiro pareamento; o painel fica utilizável durante esse tempo.

**Usar S3 ou MinIO para as mídias:** defina no `.env` `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` e, para MinIO ou outro compatível, `S3_ENDPOINT` (ex.: `https://minio.suaempresa.com.br`) com `S3_FORCE_PATH_STYLE=true`. O bucket deve existir e ser **privado**. Mídias já gravadas no disco não são migradas automaticamente.

## 9. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Página não abre | Container parado ou porta bloqueada | `docker compose ps`; libere 80/443 no firewall e no provedor. |
| Erro de certificado / HTTPS não sobe | DNS não aponta para o servidor, ou porta 80 fechada | Confira o registro A; `docker compose logs caddy`. |
| Login volta para a tela de entrada ao recarregar | Acesso por HTTP com `COOKIE_SECURE=true` | Use HTTPS ou deixe `COOKIE_SECURE=false` (o cookie já fica seguro sozinho sob HTTPS). |
| QR Code não aparece | Worker parado ou sem saída para a internet | `docker compose logs worker`; o `/health` deve mostrar `worker:true`. |
| QR aparece mas não conecta | Celular sem internet, ou limite de 4 aparelhos conectados no WhatsApp | Desconecte um aparelho antigo no celular e tente de novo. |
| Número desconecta e volta várias vezes | Rede instável, ou a mesma sessão aberta em outro servidor | Verifique se não há outra instalação com o mesmo backup ligada. |
| Todos os números caem com `code: 405` | Versão do WhatsApp Web recusada | Atualize o Baileys (seção 6). |
| Mídia aparece como "indisponível" | Mídia antiga expirou no servidor do WhatsApp, ou acima do limite | Esperado para histórico antigo; para novas, veja `docker compose logs worker`. |
| Campanha "Em andamento" sem enviar nada | Fora da janela de horário, limite diário atingido, ou nenhum número conectado | Veja Visão geral (disparos hoje) e o horário da campanha. |
| Perdi o celular com o 2FA | — | Outro administrador desliga o 2FA em Usuários. Se for o único administrador, use um código de recuperação. |
| Esqueci a senha do único administrador | — | Ponha o e-mail dele em `ADMIN_EMAIL` e uma senha nova em `ADMIN_PASSWORD` no `.env` e rode `docker compose run --rm migrate node apps/api/dist/scripts/seed.js --redefinir-senha`. O 2FA dele é desligado e a ação fica no log de auditoria. Apague a senha do `.env` depois. |

## 10. Riscos e limitações desta fase

1. **As imagens Docker não foram construídas neste ambiente de desenvolvimento** (não há Docker disponível nele). Os passos de cada imagem foram reproduzidos fora do Docker e funcionaram: dependências de produção, Prisma, migrations, criação do administrador, API, worker, painel standalone e acesso por uma única origem atrás de um proxy. A construção e a subida reais ficam a cargo do CI no GitHub (`docker compose up` com teste de login, worker e backup/restauração); o resultado aparece no pull request.
2. **O pareamento com um WhatsApp real continua sem teste.** É o primeiro passo depois de subir: um chip de teste, ler o QR, conferir histórico, envio e recebimento.
3. **O Caddyfile não foi executado aqui.** O roteamento foi validado com um proxy equivalente; o próprio Caddy roda no CI.
4. **Não há MinIO no Compose.** O suporte a S3/MinIO existe no código, mas aponta para um bucket que você já tenha; empacotar o MinIO ficaria para depois.
5. **Um servidor só, sem alta disponibilidade.** Se a máquina cair, o sistema para até ela voltar ou o backup ser restaurado em outra.
6. **Backup do banco é um dump completo diário.** Perde-se até 24 h de dados numa restauração. Para menos, use o snapshot do provedor ou replicação do PostgreSQL.
7. **Sem alertas ativos.** O sistema mostra os problemas no painel e nos logs, mas não envia e-mail nem notificação; use um monitor externo.
8. **A imagem da API é grande** (estimativa: perto de 1 GB) por causa do ffmpeg, do Prisma e das bibliotecas nativas. Não afeta o funcionamento, só o tempo do primeiro download e o disco.
