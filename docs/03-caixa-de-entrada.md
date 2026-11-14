# Fase 3 — Caixa de entrada unificada

## O que foi entregue

**Painel — tela Conversas**
- Lista única com as conversas de todos os números, da mais recente para a mais antiga, com a cor e o apelido do número, prévia da última mensagem, contador de não lidas, responsável e etiquetas.
- Filtros por número, status (aberta, pendente, encerrada), responsável (minhas, sem responsável ou um usuário), etiqueta e "somente não lidas".
- Busca por nome do contato, telefone ou texto de qualquer mensagem.
- Conversa com histórico completo paginado ("carregar mensagens anteriores"), separadores de dia, mensagem citada, reações, indicação de editada/apagada e de onde a mensagem saiu (atendente, celular, campanha, automação).
- Tiques de enviada, entregue e lida; falha de envio com o motivo.
- Mídia: imagem e figurinha embutidas, áudio e vídeo com player, documento para baixar.
- Resposta por texto (Enter envia, Shift+Enter quebra linha) e por anexo com legenda: imagem, vídeo, áudio ou qualquer documento.
- Status, responsável e etiquetas editáveis no cabeçalho; gestores criam etiquetas ali mesmo.
- Tudo em tempo real: mensagem nova, mudança de tique e mídia baixada aparecem sem recarregar.
- No celular a lista e a conversa viram telas separadas.

**API**
- `GET /api/conversations` (filtros, busca, paginação por cursor), `GET /:id`, `GET /:id/messages`, `POST /:id/messages` (JSON ou multipart), `POST /:id/read`, `PATCH /:id`, `PUT /:id/tags`.
- `GET /api/media/:id`: arquivo servido por URL assinada com validade de até 6 horas.
- `GET/POST/DELETE /api/tags` e `GET /api/users/assignable`.
- Índices trigram (`pg_trgm`) para a busca por texto, nome e telefone.

**Worker**
- Fila `outbound`: envia texto e mídia e os recibos de leitura. Mensagens de um mesmo número saem em ordem, uma por vez.

## Regras de comportamento

| Situação | O que acontece |
|---|---|
| Atendente responde pelo painel | Conversa sem responsável passa a ser dele; não lidas zeram; automação pausa; conversa encerrada reabre. |
| Atendente abre a conversa | Não lidas zeram e o contato recebe o recibo de leitura (tiques azuis). |
| Conversa é lida no celular | Não lidas zeram no painel. |
| Cliente escreve em conversa encerrada | A conversa reabre. |
| Conversa é encerrada | A automação volta a valer para o próximo contato. |
| Envio falha | A mensagem fica marcada como não enviada, com o motivo. Não há reenvio automático, para não duplicar mensagem ao cliente. |
| Atendente | Só vê conversas dos números atribuídos a ele; só pode assumir a conversa ou devolvê-la à fila. |
| Arquivo recebido que não é imagem, áudio, vídeo ou PDF | É sempre baixado como anexo, nunca aberto no navegador, para que um HTML enviado por um contato não rode dentro do painel. |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `npm test -w apps/api` — 15 testes de integração (11 de espelhamento, 4 de envio com socket simulado: troca do id provisório, eco sem duplicar, falhas, ordem por número, recibos de leitura) | passam |
| API com dados de exemplo: listagem, busca por texto e por telefone, paginação, mensagem citada, reações, mídia assinada (200) e assinatura adulterada (403) | conferido |
| Atendente: vê só as conversas do seu número; 404 ao abrir, listar ou enviar em conversa de outro número; 403 ao criar número ou atribuir a outra pessoa | conferido |
| Navegador (desktop e celular): abrir conversa, zerar não lidas, etiquetar, enviar texto e anexo, filtros, busca, carregar anteriores, editar número | conferido, sem erros de console |
| **Envio e recebimento com um WhatsApp real** | **não testado** — mesmo motivo da fase 2. No teste de navegador o envio termina em "não enviada: número desconectado", que é o caminho de falha; o caminho de sucesso foi coberto com socket simulado. |

## Riscos e limitações desta fase

1. **Sem teste contra o WhatsApp real.** Continua sendo o ponto a validar: enviar texto, imagem, áudio e documento a partir do painel e conferir os tiques.
2. **Áudio enviado pelo painel sai como arquivo de áudio**, não como "mensagem de voz". Gravar áudio no navegador não foi incluído.
3. **Sem responder citando, reagir, editar ou apagar** pelo painel; essas ações feitas no celular aparecem normalmente.
4. **Áudio e vídeo sem avanço por trecho** em arquivos grandes: o servidor entrega o arquivo inteiro (sem requisições parciais).
5. **Link de mídia vale até 6 horas** e funciona para quem o tiver nesse período. É o que permite ao navegador tocar áudio e vídeo; não compartilhe esses links.
6. **Busca por texto** percorre todas as mensagens; com milhões de mensagens e termos de 1 ou 2 letras pode ficar lenta.
7. **Lista em tempo real:** uma conversa que deixa de casar com o filtro ativo (por exemplo, foi lida com "somente não lidas" ligado) continua visível até os filtros serem reaplicados.
8. **Miniatura de vídeo** no envio depende de `ffmpeg` no servidor; sem ele o vídeo é enviado sem miniatura. Entra na imagem Docker da fase 6.
9. **Os testes automatizados gravam e apagam dados** no banco configurado no `.env`. Rode-os só em banco de desenvolvimento.
