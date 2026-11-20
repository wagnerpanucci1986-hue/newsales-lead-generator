# Captação pelo Instagram

Aba **Captação → Instagram**: você digita os @ de perfis comerciais e o sistema traz os dados públicos pela API oficial da Meta (Business Discovery). Quem tem telefone na bio ou um link de WhatsApp pode ir para Contatos.

## O que traz e o que não traz

| Traz | Não traz |
|---|---|
| Nome, bio, site, seguidores, número de posts e data do último post | Lista de seguidores de ninguém |
| Telefone e e-mail **só se estiverem escritos na bio** ou num link de WhatsApp (wa.me, api.whatsapp.com) | Telefone e e-mail do botão "Contato" do perfil (a API não entrega) |
| Perfis **comerciais ou de criador** | Perfis pessoais ou privados |

## Configurar uma vez

Precisa ser feito por quem administra o Instagram e a Página do Facebook da empresa. Os nomes dos menus da Meta mudam com frequência; se algo estiver diferente, me mande um print.

1. **Instagram profissional.** No app do Instagram: Configurações → Tipo de conta e ferramentas → Mudar para conta profissional (Empresa).
2. **Ligar à Página do Facebook.** Na Página: Configurações → Contas vinculadas → Instagram → Conectar.
3. **Criar o app da Meta.** Em developers.facebook.com → Meus apps → Criar app, tipo **Empresa**, ligado ao seu Gerenciador de Negócios. Adicione o produto **Instagram**, na opção "API com login do Facebook".
   - O app pode ficar em modo de desenvolvimento: só pessoas da sua empresa vão usá-lo. Não deve precisar de revisão da Meta (não verificado na prática).
4. **Gerar o token.** O mais estável é um **usuário do sistema**, cujo token não expira:
   - business.facebook.com → Configurações do negócio → Usuários → Usuários do sistema → Adicionar (função Administrador).
   - Em "Atribuir ativos", dê acesso ao **app** e à **Página**.
   - Clique em **Gerar token**, escolha o app, validade **Nunca** e marque as permissões `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` e `pages_show_list`. Se a Página estiver no Gerenciador de Negócios, marque também `ads_read`.
   - Alternativa rápida para testar: o token do Explorador da Graph API, que expira em poucas horas.
5. **Conectar no sistema.** Configurações → Instagram → cole o token → Conectar. O sistema confere o token na Meta e mostra a conta encontrada. O token fica guardado cifrado, como as sessões do WhatsApp.

## Como usar

1. Cole até **30 perfis** por vez: `@loja`, `loja` ou o link do perfil, um por linha.
2. Clique em **Pesquisar**. Perfis consultados nos últimos 7 dias vêm do histórico, sem gastar consulta.
3. Quem tem telefone já vem marcado. Confira a bio, desmarque o que não faz sentido e clique em **Importar para Contatos**. Sugestão de etiqueta: `Instagram` e o segmento.
4. Antes da campanha, rode **Verificar WhatsApp** nos contatos importados e use a base legal **Legítimo interesse**, com a frase de saída.

**Onde achar os @:** concorrentes e parceiros do segmento, quem marca ou é marcado por eles, resultados de busca do próprio Instagram, sites e listas de expositores de feiras. A pesquisa é manual de propósito: a Meta não oferece busca por categoria ou cidade, e as ferramentas que fazem isso usam robôs proibidos pelos termos dela.

## O que foi construído

| Parte | Onde |
|---|---|
| Cliente da Graph API: descobre a conta pelo token, consulta perfis, traduz os erros da Meta | `apps/api/src/instagram/graph.ts` |
| Leitura dos @ e extração de telefones e e-mails da bio e do link | `apps/api/src/instagram/extract.ts` |
| Pesquisa com histórico de 7 dias e parada no limite da Meta | `apps/api/src/instagram/lookup.ts` |
| Importação para Contatos (mesma regra da base de CNPJ, agora compartilhada) | `apps/api/src/instagram/to-contacts.ts`, `src/lib/prospects.ts` |
| Rotas `/api/instagram/*` | `apps/api/src/modules/instagram/routes.ts` |
| Aba Instagram e cartão em Configurações | `apps/web/src/app/(painel)/captacao/instagram/`, `components/instagram/ConnectionCard.tsx` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| 5 testes novos com a Meta simulada: leitura de @ e links, extração (celular antes do fixo, links wa.me, não confundir CNPJ e CEP com telefone), token guardado cifrado, token vencido, perfil inexistente, cache, parada no limite da Meta, importação com bloqueio | passam |
| Navegador, com perfis de teste: abas, histórico com filtros, pesquisa com link e @ inválido, seleção automática, janela de importação, aviso quando a Meta não responde, cartão em Configurações, celular | conferido, sem erros |
| **Consulta real à Meta** | **não testado.** A rede do ambiente de desenvolvimento bloqueia a Meta. O primeiro teste real é conectar o token no seu computador. |

## Riscos e limitações

1. **Consulta real não testada.** O formato da resposta segue a documentação da Meta; se a conexão ou a pesquisa falharem, mande o print da mensagem de erro.
2. **Versão da API.** O sistema usa a Graph API `v24.0`. Quando a Meta desativar essa versão, troque `META_GRAPH_VERSION` no `.env` e reinicie.
3. **Poucos perfis com telefone.** Muitas empresas deixam o contato só no botão do perfil, que a API não entrega. Espere que boa parte dos perfis venha sem telefone.
4. **Limite de consultas.** A Meta limita as consultas por hora e por conta. Quando isso acontece, o sistema para, avisa e devolve os perfis que faltaram para a caixa de pesquisa.
5. **Termos da Meta.** Os dados vêm pela API oficial, mas os termos da plataforma restringem o uso dos dados (por exemplo, proíbem vender ou repassar). Use só para a sua própria prospecção.
6. **LGPD.** Em perfis de criador e de autônomos, o telefone da bio costuma ser da própria pessoa. Valem as mesmas regras da base de CNPJ: legítimo interesse, oferta relacionada ao negócio da pessoa, frase de saída em toda mensagem e lotes pequenos.
7. **Token.** Token de usuário comum expira (horas ou 60 dias). Com o de usuário do sistema isso não acontece. Se for revogado, a tela avisa e é só conectar de novo.
