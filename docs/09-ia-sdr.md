# IA do SDR

A IA atende quem responde às campanhas marcadas com **Atendimento pela IA do SDR**: qualifica o lead, marca a reunião com um consultor no Google Agenda, faz os follow-ups e confirma a reunião. Ela segue a base de conhecimento da New Sales (o documento "Base de Conhecimento — Agente SDR New Sales"), que fica editável na tela.

## Como funciona

1. **Campanha.** Escreva a 1ª mensagem e, se quiser, clique em **Gerar variações**. A IA escreve versões com o mesmo sentido; você revisa, edita e aprova. Cada envio sorteia uma delas. O sistema avisa se alguma perdeu uma variável (`{{primeiro_nome}}`) ou a frase de saída. Marque **Atendimento pela IA do SDR**.
2. **Resposta do lead.** A IA espera alguns segundos (padrão: 40) para juntar mensagens seguidas e responde com "digitando…", em até dois balões curtos. A cada resposta ela atualiza a **ficha do lead**: cargo, produto, estados, porte, experiência com licitação, dor, objeções, melhor horário, temperatura e etapa.
3. **Reunião.** Quando o lead aceita conversar, a IA consulta os horários livres dos consultores no Google Agenda e oferece duas opções em dias diferentes. Com o "sim", ela cria o evento com link do Meet, convida o consultor (e o lead, se ele deu e-mail) e coloca a ficha na descrição do evento.
4. **Confirmação.** Na véspera e cerca de duas horas antes, a IA confirma com o lead.
5. **Sem resposta.** Follow-ups em 2, 5 e 10 dias (configurável), só no horário de atendimento e espaçados entre si. O último é a despedida cordial; depois dele, o lead fica como frio.
6. **Passagem para humano.** Nas situações da tabela de escalonamento (valores, contrato, jurídico, cliente atual, órgão público, LGPD, lead irritado), a IA avisa o lead, a conversa vai para **Pendente** e a IA para de responder. A ficha aparece na conversa.
7. **Descadastro.** "SAIR" (ou outra palavra configurada) ou qualquer pedido para parar: o contato vai para a lista de bloqueio e a IA encerra.

**Um atendente pode assumir a qualquer momento.** Basta responder pelo painel ou pelo celular, ou clicar em **Assumir (pausar IA)** na faixa da conversa. **Devolver para a IA** faz ela voltar a atender.

## Telas

- **SDR (IA) → Visão geral:** pendências de configuração, leads por temperatura, reuniões marcadas, uso da semana e a lista de leads, com link para a conversa.
- **SDR (IA) → Configuração** (só administrador):
  - liga e desliga a IA;
  - nome do SDR, tempo de espera e profundidade do raciocínio;
  - consultores (nome e e-mail da agenda);
  - regras da reunião (duração, dias, horário, antecedência);
  - dias de follow-up;
  - base de conhecimento.
- **SDR (IA) → Google Agenda:** conexão com o Google.
- **SDR (IA) → Testar:** você faz o papel do lead e vê o que a IA responderia e quais ações tomaria. Nada é enviado, gravado ou marcado; a agenda é só lida.
- **Conversas:** faixa da IA com situação, temperatura, etapa, próxima ação, ficha e botões.
- **Campanhas:** variações com IA e opção de atendimento pela IA.

## Configurar

### 1. Chave da API da Anthropic

1. Em console.anthropic.com → API Keys, crie uma chave. O uso é cobrado à parte da assinatura do Claude.
2. No arquivo `.env` (na pasta do sistema), preencha `ANTHROPIC_API_KEY=sk-ant-...`.
3. Rode `docker compose up -d` para reiniciar com a chave.

Se a tela de teste mostrar *"This API key is not scoped to a workspace"*, a chave foi criada fora de um workspace. Crie outra dentro de um workspace (Console → Settings → Workspaces → o workspace → API Keys) ou informe o workspace no `.env` com `ANTHROPIC_WORKSPACE_ID=wrkspc_...`.

O modelo padrão é o Claude Opus 5.5, com raciocínio de profundidade média. A persona e a base de conhecimento ficam em cache, o que barateia as chamadas seguidas. Se o modelo recusar responder, a API tenta outro modelo automaticamente; se todos recusarem, a conversa passa para uma pessoa.

### 2. Google Agenda

1. Em console.cloud.google.com, crie um projeto e ative a **Google Calendar API**.
2. Em **Tela de consentimento OAuth**, escolha o tipo **Interno**, se a New Sales usar Google Workspace. Se não usar, escolha **Externo** e adicione o seu e-mail como usuário de teste.
3. Em **Credenciais → Criar credenciais → ID do cliente OAuth**, escolha **Aplicativo da Web** e, em **URIs de redirecionamento autorizados**, cole o endereço mostrado na tela do sistema (no seu computador: `http://localhost/api/google/callback`).
4. Na tela **SDR (IA) → Google Agenda**, cole o ID e a chave secreta e clique em **Conectar Google Agenda**. Entre com a conta que vai criar as reuniões.
5. Essa conta precisa **ver a disponibilidade** das agendas dos consultores (no Workspace isso costuma ser padrão; fora dele, cada consultor compartilha a agenda com essa conta). Agenda que não pode ser lida fica de fora das ofertas de horário.

No modo **Externo** sem publicação, o Google expira a autorização em 7 dias. Para uso contínuo, use o tipo **Interno** (Workspace) ou publique o app.

### 3. Consultores e regras

Em **SDR (IA) → Configuração**:
1. Cadastre os consultores com o e-mail da agenda de cada um.
2. Ajuste as regras da reunião (padrão: 20 minutos, segunda a sexta, 9h às 18h, 3 horas de antecedência) e ligue a IA.
3. Antes da primeira campanha, use **Testar** para conferir o tom.

## O que foi construído

| Parte | Onde |
|---|---|
| Laço do agente: prompt (persona e base em cache + contexto do lead), chamada ao Claude, ferramentas, recusa | `apps/api/src/sdr/agent.ts`, `prompt.ts`, `model.ts` |
| Ferramentas: ficha, horários, reunião, passagem para humano, descadastro, retorno, encerramento | `apps/api/src/sdr/tools.ts` |
| Horários livres e fuso | `apps/api/src/sdr/slots.ts` |
| Google Agenda (OAuth, disponibilidade, evento com Meet) | `apps/api/src/sdr/google.ts` |
| Disparo da resposta, follow-ups e lembretes | `apps/api/src/sdr/trigger.ts`, `scheduler.ts`, `apps/api/src/jobs/sdr.ts` |
| Variações da 1ª mensagem | `apps/api/src/sdr/variations.ts` |
| Teste pela tela | `apps/api/src/sdr/simulate.ts` |
| Base de conhecimento padrão | `apps/api/src/sdr/knowledge-base.ts` |
| Telas | `apps/web/src/app/(painel)/sdr/`, `components/sdr/`, `components/inbox/SdrBar.tsx`, `components/campaigns/CampaignForm.tsx` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| 10 testes novos com o Claude e o Google simulados: <br>• papéis da conversa e marcadores (o lead não consegue se passar pelo sistema); <br>• horários com antecedência, agenda ocupada e agenda sem acesso; <br>• resposta com ficha, horários e envio em dois balões; <br>• pedido ao Claude (cache, contexto, ferramentas, fallback); <br>• reunião no Google com Meet e convidados; <br>• lembrete de véspera; <br>• mensagem mais nova e humano assumindo; <br>• descadastro em palavras; <br>• recusa; <br>• os três follow-ups e o encerramento; <br>• teste pela tela sem efeitos; <br>• variações com avisos | passam; suíte completa com 55 testes |
| Navegador, com o Claude simulado: <br>• pendências de configuração; <br>• lista de leads; <br>• salvar consultores e ligar a IA; <br>• tela do Google; <br>• conversa de teste formando a ficha; <br>• variações com avisos na campanha; <br>• faixa da IA na conversa, com ficha e "Assumir"; <br>• celular sem rolagem lateral | conferido, sem erros |
| **Respostas reais do Claude e Google Agenda real** | **não testados.** O ambiente de desenvolvimento não tem a sua chave nem acesso à sua conta Google. O primeiro teste real é na aba **Testar**, depois de colocar a chave. |

## Riscos e limitações

1. **Qualidade das respostas não medida.** A IA segue a base de conhecimento, mas só conversas reais mostram se o tom e as decisões estão certos. Teste bastante na aba **Testar** e comece com uma campanha pequena, acompanhando as conversas.
2. **Custo por uso.** Cada resposta chama a API (algumas chamadas quando a IA consulta a agenda). O cache da persona e da base reduz o custo. O uso da semana aparece na Visão geral; o valor em reais, no painel da Anthropic.
3. **Risco de banimento.** Uma conversa iniciada pelo lead é de baixo risco, mas follow-ups em massa não são. Por isso eles saem só no horário de atendimento, espaçados, e param depois do terceiro.
4. **Dados pessoais.** O histórico da conversa e a ficha vão para a API da Anthropic a cada resposta. Pela política padrão da API, os dados não são usados para treinar modelos, mas ficam retidos por um período para segurança. Inclua isso no registro de tratamento da LGPD.
5. **Áudio e imagem.** A IA não ouve áudio nem vê imagem: ela sabe que o lead mandou e pede para escrever, se precisar.
6. **Agenda.** As reuniões são criadas na agenda da conta Google conectada, com o consultor como convidado. Se o consultor marcar outra coisa no mesmo horário, a IA não fica sabendo depois.
7. **Honestidade.** Se perguntarem, a IA diz que é a assistente virtual da New Sales e oferece uma pessoa. Isso evita enganar o lead, e você pode ajustar o texto na base de conhecimento.
8. **Respostas atrasadas.** Se o WhatsApp estiver desconectado, a resposta é tentada de novo até três vezes; depois, fica registrada como erro na conversa.
