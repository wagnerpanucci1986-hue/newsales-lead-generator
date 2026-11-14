# Fase 4 — Contatos, listas e campanhas com anti-banimento

## O que foi entregue

**Contatos**
- Cadastro manual, edição, exclusão, ações em lote (adicionar a lista, etiquetar, excluir), busca e filtros por lista, etiqueta, situação no WhatsApp e descadastro.
- Campos personalizados livres, que viram variáveis de mensagem.
- Importação de **CSV e XLSX** em três passos: envio do arquivo, mapeamento de colunas (com sugestão automática e amostra dos dados) e resultado. Aceita vírgula, ponto e vírgula ou tab, e arquivos do Excel em Latin-1.
- Validação de telefone no padrão brasileiro: DDD existente, celular com 9 dígitos (celular antigo sem o 9 é completado), fixo aceito, `+55` opcional. Números de outros países precisam vir com `+`.
- Deduplicação pelo telefone, dentro do arquivo e contra a base. Reimportar atualiza o contato sem apagar o que a planilha não traz.
- Registro da origem do consentimento por contato (LGPD).
- Verificação "tem WhatsApp" em lotes de 25 com intervalo de 4 a 8 s, feita por um número escolhido pelo operador.
- **Listas** estáticas e **lista de bloqueio** global (manual, em massa ou por descadastro).

**Campanhas**
- Mensagem com variáveis (`{{nome}}`, `{{primeiro_nome}}`, `{{empresa}}`, `{{email}}`, `{{telefone}}` e campos personalizados) e spintax (`{Olá|Oi|E aí}`, inclusive aninhado).
- Anexo: imagem, PDF, áudio ou vídeo, com o texto como legenda.
- Prévia com contatos reais do público, contagem de quem recebe e de quem fica de fora (com o motivo) e aviso sobre variáveis inexistentes.
- Público por listas, com filtro opcional por etiqueta e por "só verificados no WhatsApp". É obrigatório escolher lista ou etiqueta: não existe "enviar para todos".
- Agendamento, dias da semana e faixa de horário.
- Distribuição automática entre os números escolhidos.
- Pausar, retomar e cancelar.
- Relatório em tempo real: enviadas, entregues, lidas, respondidas, falhas, puladas, descadastros, envios por número, lista de destinatários com filtro e exportação CSV.

**Anti-banimento**

| Proteção | Como funciona |
|---|---|
| Intervalo aleatório | Cada número sorteia a espera entre o mínimo e o máximo da campanha (padrão 15–60 s; piso de 5 s). |
| Pausa longa | A cada N mensagens do número no dia (padrão 20), pausa sorteada (padrão 5–15 min). |
| Limite diário | Por número; ao atingir, o número só volta a disparar no dia seguinte. |
| Aquecimento | Número novo começa com 20 mensagens/dia e cresce 25% ao dia até o limite (chega a 200 em cerca de 12 dias). Configurável. |
| "Digitando…" | Antes de cada mensagem, por 2 a 8 s conforme o tamanho do texto. |
| Janela de envio | Fora dos dias e horários da campanha, nada sai. |
| Falhas em sequência | 5 falhas seguidas pausam o número (status **Suspeito**). |
| Queda de qualidade | Se menos de 50% das últimas 20 mensagens de campanha do número foram entregues, ele é pausado. |
| Texto variado | Spintax e variáveis evitam mensagens idênticas em sequência. |
| Descadastro | Palavra-chave (padrão SAIR, PARAR, STOP, CANCELAR, DESCADASTRAR) bloqueia o contato, tira-o das campanhas pendentes e envia uma confirmação única. |
| Checagem na hora do envio | Blacklist e descadastro são conferidos de novo imediatamente antes de cada mensagem. |
| Consentimento | Aviso de LGPD nas telas de campanha; iniciar exige uma confirmação, gravada no log de auditoria com o usuário. |

Um número pausado continua conectado e atendendo normalmente; só deixa de disparar até um gestor clicar em **Liberar disparos** na tela Números.

## Decisões de implementação

- **A fila de disparo é a tabela `CampaignRecipient`, não o BullMQ.** O próximo horário de envio de cada número fica em `WaNumber.nextSendAt`, e um laço no worker cuida do resto. Reiniciar o worker ou o Redis não perde nem duplica destinatários. O BullMQ segue em uso para iniciar campanhas, importar, verificar contatos, enviar respostas e baixar mídia.
- **Rodízio por reserva:** cada número reserva o próximo contato da fila com `FOR UPDATE SKIP LOCKED`. Não há divisão prévia; se um número cai ou é pausado, os outros seguem com o que resta. Contatos que já têm conversa com um número vão preferencialmente para ele.
- **Envio interrompido não é repetido.** Se o worker cai no meio de um envio, o destinatário é marcado como falha após 10 minutos, com orientação para conferir na conversa.
- **Os números do relatório são sempre contados nos destinatários**, sem contadores paralelos que possam divergir.
- **Edição só em rascunho.** Depois de iniciada, a campanha só pode ser pausada, retomada ou cancelada.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `npm test -w apps/api` — 27 testes de integração. Os 12 novos cobrem telefone, spintax e variáveis, janela e aquecimento, importação, verificação, público, rodízio entre dois números, intervalo e pausa longa, limite diário, janela, campanha pausada, pausa por falhas e por queda de entrega, recibos, resposta e descadastro | passam |
| Navegador, de ponta a ponta: importar planilha (mapeamento sugerido, 13 novos, 1 inválido, 1 duplicado unificado), bloquear telefone, criar campanha, bloqueio de início sem consentimento, aviso de variável inexistente, envio com rodízio (3 e 3 entre dois números), pausa (nada sai durante a pausa), retomada, conclusão, filtro de puladas, configurações, layout no celular | conferido, sem erros de console |
| **Disparo por um WhatsApp real** | **não testado.** O teste de navegador usou um worker com sockets simulados, que aceitam todo envio e confirmam a entrega. O laço de disparo, o ritmo e o relatório são os reais; a conversa com o WhatsApp não. |

## Riscos e limitações desta fase

1. **Nenhuma destas proteções garante que o número não será banido.** Elas reduzem os sinais mais óbvios de automação. O que mais pesa é o conteúdo e quem recebe: mensagens para quem não pediu geram denúncias, e denúncia bane independentemente do ritmo.
2. **Os valores padrão são conservadores, mas são estimativas.** O WhatsApp não publica limites. Comece abaixo dos padrões com chips novos e observe a taxa de entrega antes de subir.
3. **Sem teste contra o WhatsApp real** (acima). Em especial, "digitando…", a consulta de número e os recibos de entrega precisam ser observados com um chip de teste.
4. **Detecção de banimento é indireta.** O sistema percebe falha de envio, queda de entrega e desconexão com recusa. Restrições silenciosas (mensagens aceitas e nunca entregues) só aparecem na checagem de qualidade, que precisa de 20 envios com mais de 30 minutos.
5. **"Respondida"** é atribuída à campanha mais recente enviada ao contato por aquele número nos últimos 7 dias.
6. **Janela de envio** usa o fuso de Brasília; não há seleção de fuso na tela.
7. **Fixos** são aceitos na importação (podem ter WhatsApp Business); sem verificação, o envio descobre na hora e pula quem não tem.
8. **Importação** lê o arquivo inteiro em memória, com teto de 200 mil linhas e do tamanho máximo de upload (`MAX_UPLOAD_MB`).
9. **Segmentação** é por lista e etiqueta. Não há filtro por valor de campo personalizado.
10. **Áudio de campanha** sai como arquivo de áudio, não como mensagem de voz.
11. **Remover alguém da lista de bloqueio** também desfaz o descadastro. Faça isso só a pedido da própria pessoa.
