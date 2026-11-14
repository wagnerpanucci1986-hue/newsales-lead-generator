# Fase 2 — Sessões múltiplas, QR Code e espelhamento

## O que foi entregue

**Worker (`apps/api/src/worker.ts`)**
- `SessionManager`: uma sessão Baileys por número, QR Code publicado em tempo real, reconexão com backoff (2 s → 60 s) e reconexão automática de todos os números pareados quando o worker sobe.
- Tratamento dos motivos de queda: aparelho desvinculado (pede novo QR), conta recusada pelo WhatsApp (marca **Banido** e não insiste), sessão aberta em outro lugar (não disputa), reinício pedido pelo servidor (reconecta na hora).
- Credenciais da sessão no Postgres, cifradas com AES-256-GCM (`whatsapp/auth-state.ts`).
- Trava de líder no Redis: um segundo worker fica em espera em vez de abrir as mesmas sessões.
- O mesmo chip pareado em dois cadastros é detectado e desfeito.

**Espelhamento (`whatsapp/mirror.ts`)**
- Texto, imagem, áudio, vídeo, documento, figurinha, localização, contato e reação; tipos não mapeados são guardados como "outros" com o conteúdo bruto.
- Mensagens enviadas pelo celular ou pelo WhatsApp Web entram com origem `PHONE`.
- Tiques de enviada/entregue/lida/ouvida, sem regredir quando os recibos chegam fora de ordem.
- Edição e exclusão registradas (o texto original da mensagem apagada é mantido).
- Histórico entregue no pareamento, sem contar como "não lida".
- Conversas identificadas por LID são unificadas com a do telefone quando o WhatsApp revela o par.
- Conversa lida no celular zera as não lidas no painel.
- Download de mídia em fila própria, com novas tentativas, para disco local ou S3/MinIO.

**API (`apps/api/src/server.ts`)**
- Login com e-mail e senha (argon2id), access token de 15 min e refresh token rotativo em cookie `httpOnly`; reuso de refresh token encerra todas as sessões do usuário.
- Números: listar, criar (recusa o 11º), editar apelido/cor/limite/aquecimento, conectar, desconectar, desvincular, remover.
- Socket.IO autenticado; cada usuário só entra nas salas dos números que pode ver.
- Log de auditoria para login e ações sobre números.

**Painel (`apps/web`)**
- Login e tela **Números**: cartões com status em tempo real, modal do QR Code, formulário de apelido/cor/limite diário/aquecimento.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `npm test -w apps/api` — 11 testes de integração do espelhamento e das credenciais cifradas, contra Postgres real | passam |
| API: login, senha errada, refresh rotativo e detecção de reuso, validação de entrada | conferido com chamadas reais |
| Limite de 10: 10 criações aceitas, a 11ª recusada com 409 | conferido |
| Painel no navegador: login, sessão mantida ao recarregar, botão de adicionar bloqueado no limite, modal do QR e mudança de status por evento em tempo real, layout no celular | conferido |
| Queda de conexão: novas tentativas com backoff; "Desconectar" interrompe as tentativas | conferido |
| **Pareamento com um WhatsApp real (leitura do QR, histórico, mídia)** | **não testado** — o ambiente de desenvolvimento não tem acesso de rede ao WhatsApp. O QR e os eventos de status do teste de navegador foram simulados. |

O último item precisa ser validado na sua máquina ou servidor antes de seguir confiando na fase.

## Riscos e limitações desta fase

1. **Sem teste contra o WhatsApp real** (acima). É o primeiro ponto a validar.
2. **Histórico grande demora.** Cada mensagem do histórico é gravada individualmente; uma conta com dezenas de milhares de mensagens pode levar vários minutos após o pareamento. `SYNC_FULL_HISTORY=false` limita ao período recente.
3. **Mídia do histórico:** só é baixada para mensagens de até `HISTORY_MEDIA_DAYS` dias (padrão 7); as mais antigas ficam sem arquivo.
4. **Enquetes, botões e listas** aparecem como "mensagem não suportada" (o conteúdo bruto é guardado).
5. **Recibo de leitura em grupo:** a mensagem é marcada como lida quando o primeiro participante lê.
6. **Nomes da agenda do celular** servem só para dar título a conversas novas; não viram contatos no sistema, para não misturar a agenda pessoal com a base de disparo.
7. **Versão do WhatsApp Web:** usa a versão embutida no Baileys. Se o WhatsApp passar a recusar conexões (erro 405), é preciso atualizar a biblioteca.
8. **Sem proxy por número.** Todos os números saem pelo mesmo IP do servidor, o que é um sinal de risco de banimento em volume. Pode ser acrescentado depois.
9. **Socket.IO e permissões:** se o acesso de um atendente a um número for alterado, a mudança vale no tempo real só depois que ele reconectar (as consultas à API respeitam na hora).
10. **Correção posterior:** a API só liberava GET/POST no CORS, então editar e remover números pelo navegador falhava. Corrigido na fase 3, quando o teste de navegador passou a cobrir a edição.
11. **Envio pelo painel** ainda não existe — entra na fase 3 junto com a caixa de entrada. Autenticação em dois fatores e gestão de usuários entram na fase 5.
