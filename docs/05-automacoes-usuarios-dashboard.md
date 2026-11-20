# Fase 5 — Automações, usuários e dashboard

## O que foi entregue

**Automação de respostas** (tela Automações)
- Regras por **palavra-chave** (contém, é exatamente, começa com) e por **fora do horário** de atendimento.
- Ação **responder** ou **encaminhar para atendente**: a conversa vai para "Pendente" e a automação para de responder nela.
- A resposta aceita variáveis (`{{primeiro_nome}}`) e spintax.
- Regra válida para todos os números ou para um só; prioridade para desempate; intervalo mínimo para não repetir a mesma resposta na mesma conversa.
- Horário de atendimento (dias e faixa de horas) configurável na mesma tela.

Quando a automação fica quieta:

| Situação | Motivo |
|---|---|
| Um atendente respondeu pelo painel ou pelo celular | Um humano assumiu. Volta a valer quando a conversa é encerrada. |
| O contato enviou a palavra de descadastro | O descadastro tem precedência; só a confirmação de saída é enviada. |
| O contato está na lista de bloqueio | Ninguém bloqueado recebe resposta automática. |
| A mensagem chegou há mais de 5 minutos | Evita responder a mensagens antigas sincronizadas depois de uma queda. |
| A mesma regra já respondeu nesta conversa dentro do intervalo | Evita repetição e laço entre dois robôs. |
| Conversa em grupo | Automação só vale para conversas individuais. |

"Contém" compara palavras inteiras, sem diferenciar maiúsculas, acentos ou pontuação: a palavra-chave "oi" não dispara em "coisa".

**Usuários e segurança** (telas Usuários e Minha conta)
- Cadastro de usuários com perfil **Administrador**, **Gestor** ou **Atendente**, ativação/desativação e redefinição de senha.
- Para o Atendente, escolha dos números que ele pode ver. A restrição vale no servidor, em todas as consultas e no tempo real.
- **Verificação em duas etapas (2FA)** opcional por aplicativo autenticador (TOTP), com QR Code, 10 códigos de recuperação de uso único e desligamento pelo administrador em caso de perda do celular.
- Troca da própria senha, encerrando as outras sessões.
- **Log de auditoria** consultável por tipo de ação: acessos, usuários, números, campanhas, contatos, lista de bloqueio, conversas, automações e configurações.
- Proteções: não é possível desativar ou rebaixar o próprio usuário nem deixar o sistema sem administrador ativo; desativar, trocar a senha ou mudar o perfil de alguém encerra as sessões abertas dele.

| Recurso | Administrador | Gestor | Atendente |
|---|---|---|---|
| Visão geral | tudo | tudo | só os seus números, sem campanhas |
| Conversas | todas | todas | só dos números atribuídos |
| Números | gerencia | gerencia | só visualiza os seus |
| Campanhas, contatos, automações | sim | sim | não |
| Configurações de descadastro e horário | sim | sim | não |
| Parâmetros de anti-banimento | sim | só visualiza | não |
| Usuários e auditoria | sim | não | não |

**Dashboard** (tela Visão geral, página inicial)
- Cartões: números conectados, conversas não lidas e aguardando atendente, mensagens no período, taxa de resposta e de entrega das campanhas.
- Alerta no topo para números pausados ou banidos, com o motivo.
- Gráfico de mensagens enviadas e recebidas por dia (7, 14, 30 ou 90 dias), com leitura por ponteiro e versão em tabela.
- Saúde de cada número: situação, disparos do dia frente ao teto (com indicação de aquecimento), enviadas, recebidas e falhas.
- Campanhas ativas com progresso.
- Atualiza sozinho quando chegam mensagens ou muda o estado de números e campanhas.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `npm test -w apps/api` — 33 testes de integração. Os 6 novos cobrem TOTP contra os vetores da RFC 6238, comparação de palavra-chave, resposta com variável e intervalo, encaminhamento e pausa, fora do horário, regra de outro número e precedência do descadastro | passam |
| Navegador: dashboard com gráfico e alerta; criação de regra; criação de atendente com número atribuído; auditoria; ativação do 2FA (código errado recusado); login com código do aplicativo; código de recuperação aceito uma vez e recusado na segunda; menu e dados restritos do atendente; 403 nas áreas de gestor; layout no celular | conferido |
| Os códigos TOTP do teste de navegador foram gerados por uma implementação separada, escrita no próprio teste | o servidor aceitou |
| **Resposta automática chegando a um WhatsApp real** | **não testado.** A decisão de responder e o conteúdo foram testados; a entrega usa o mesmo caminho de envio das fases anteriores. |

## Riscos e limitações desta fase

1. **Automação responde só com texto.** Anexo em resposta automática não foi incluído.
2. **Um único horário de atendimento** para todos os números, com a mesma faixa em todos os dias marcados. Não há feriados nem horários diferentes por dia.
3. **Sem fluxos de várias etapas** (menus, perguntas em sequência). Cada regra é uma pergunta e uma resposta.
4. **Risco de laço com outro robô:** o intervalo mínimo por regra limita a uma resposta por conversa no período, mas não detecta que o outro lado é um robô. Evite intervalos muito curtos.
5. **Resposta automática também é mensagem enviada.** Em volume alto, conta para o comportamento do número perante o WhatsApp, embora não entre no limite diário de disparos.
6. **2FA é opcional por usuário.** Não há como o administrador torná-lo obrigatório. Recomendo ativar ao menos para administradores.
7. **Sem "esqueci minha senha" por e-mail:** o sistema não envia e-mails. Quem redefine é um administrador; se o único administrador perder a senha, é preciso rodar o seed ou alterar no banco.
8. **Um código TOTP pode ser reutilizado dentro da janela de ~90 s** em que é válido. O limite de 10 tentativas de login a cada 5 minutos por IP reduz o risco de força bruta.
9. **O access token vale 15 minutos.** Um usuário desativado perde o acesso na hora (o servidor confere a cada requisição), mas a conexão de tempo real já aberta dura até cair.
10. **Dashboard conta a partir da conexão de cada número**; o histórico importado no pareamento não entra nas séries diárias. O dia vira à meia-noite do fuso configurado em `APP_TIMEZONE`.
11. **O log de auditoria não tem retenção nem exportação**: cresce indefinidamente e só é consultado pela tela.
