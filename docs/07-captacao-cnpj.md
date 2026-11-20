# Captação pela base de CNPJ

Nova tela **Captação**, para encontrar empresas na base pública de CNPJ da Receita Federal e levá-las para Contatos. Segue o modelo do "Registro Nacional" do Redrive.

## Como usar

1. **Captação → Atualizar base**: escolha as UFs (comece pelo PR) e confirme.
   - O sistema baixa os arquivos públicos da Receita (cerca de **7 GB**, mesmo para uma UF só, porque eles não vêm separados por estado).
   - Mantém só as empresas **ativas e com telefone** das UFs escolhidas e apaga os arquivos baixados ao terminar.
   - Pela medição com arquivos de teste, a primeira atualização deve levar de **30 a 60 minutos**, conforme a internet e o computador. Dá para sair da tela; o andamento aparece no cartão da base.
2. **Filtre**. A tela segue as mesmas seções da busca avançada do Redrive:
   - **Busca geral:** procura ao mesmo tempo em razão social, nome fantasia, atividade (código ou descrição), CNPJ, e-mail, telefone, endereço, bairro e município. CNPJ e telefone podem ir com ou sem pontuação.
   - **Identificação da empresa:** razão social ou nome fantasia, atividade principal (CNAE, com opção de incluir a secundária) e natureza jurídica.
   - **Localização:** UF, município, bairro, CEP e DDD.
   - **Dados financeiros:** capital social de/até e porte. A situação cadastral fica fixa em "Ativa", porque a base só guarda empresas ativas.
   - **Outros parâmetros:** MEI, matriz ou filial, tipo de telefone, com e-mail, esconder quem já é contato e esconder telefones de contador.
   - O padrão já vem pensado para prospecção: só matriz, sem MEI, com celular, escondendo quem já é contato, quem está bloqueado e telefones de contador.
   - A lista vem ordenada pelo **maior capital social**.
3. **Importe**: marque empresas ou importe as primeiras N do filtro (até 5.000 por vez).
   - Defina etiquetas (sugestão: `CNPJ`, UF e segmento) e uma lista.
   - Os contatos chegam com nome em formato legível (a Receita grava tudo em maiúsculas) e com campos prontos para as mensagens: `{{cnpj}}`, `{{cnae}}`, `{{cidade}}`, `{{uf}}`, `{{bairro}}`, `{{porte}}`, `{{capital_social}}`, `{{tipo}}`.
4. **Verifique o WhatsApp** dos contatos importados (Contatos → Verificar WhatsApp) antes da campanha.
5. Na campanha, escolha a base legal **Legítimo interesse**. O sistema exige que a mensagem diga como sair, e o botão "Inserir frase de saída" resolve.

### Se o download automático falhar

O endereço onde a Receita publica os arquivos muda de tempos em tempos. O sistema tenta, nesta ordem:

1. a pasta `dados-cnpj` do sistema;
2. a listagem clássica `arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/`;
3. o compartilhamento Nextcloud da Receita.

Se as duas últimas falharem, a tela mostra o erro. Aí:

1. Abra o portal de dados abertos do CNPJ (dados.gov.br, conjunto "Cadastro Nacional da Pessoa Jurídica") e entre na pasta do mês mais recente.
2. Baixe pelo navegador: `Estabelecimentos0.zip` a `Estabelecimentos9.zip`, `Empresas0.zip` a `Empresas9.zip`, `Simples.zip`, `Municipios.zip`, `Cnaes.zip` e `Naturezas.zip`.
3. Coloque todos na pasta `dados-cnpj`, ao lado do `docker-compose.yml` (não precisa descompactar).
4. Clique em **Atualizar base** de novo. Depois, apague os ZIPs para liberar espaço.

Os endereços também podem ser trocados no `.env`: `CNPJ_LISTING_URL`, `CNPJ_NEXTCLOUD_URL` e `CNPJ_NEXTCLOUD_TOKEN`.

## O que foi construído

| Parte | Onde |
|---|---|
| Leitura dos arquivos da Receita (latin1, `;`, aspas), em streaming, sem descompactar no disco | `apps/api/src/cnpj/zip-csv.ts`, `layout.ts` |
| Três origens dos arquivos, com descoberta do mês mais recente | `apps/api/src/cnpj/source.ts` |
| Importação: tabelas de apoio → estabelecimentos (ativas, UF, telefone) → empresas → Simples/MEI → remoção do que saiu → telefones de contador | `apps/api/src/cnpj/importer.ts` |
| Busca com todos os filtros e importação para Contatos | `apps/api/src/cnpj/search.ts`, `to-contacts.ts`, `src/modules/cnpj/routes.ts` |
| Base legal das campanhas (consentimento ou legítimo interesse) | `apps/api/src/campaigns/legal.ts` |
| Tela Captação e escolha da base legal na campanha | `apps/web/src/app/(painel)/captacao/`, `components/captacao/`, `components/campaigns/CampaignForm.tsx` |

**Tratamento dos dados**
- **Telefones:** são normalizados; celular antigo de 8 dígitos ganha o 9; DDD com zero à esquerda e número com DDD embutido são aceitos.
- **Telefone repetido:** matriz e filial com o mesmo telefone viram um contato só.
- **Telefone de contador:** quando o mesmo número aparece em 3 ou mais empresas diferentes, ele é escondido da busca por padrão.
- **MEI:** só conta como MEI quem não tem data de exclusão. A razão social de MEI ("12.345.678 FULANO") vira o nome da pessoa.
- **CNPJ alfanumérico:** os CNPJs com letras, emitidos desde julho de 2026, são aceitos.
- **Atualização sem duplicar:** rodar de novo substitui os dados das UFs escolhidas e remove as empresas que deixaram de estar ativas ou sem telefone.
- **Contatos já existentes:** só ganham etiquetas e lista e têm campos vazios completados; o que alguém editou não é sobrescrito. Quem está na lista de bloqueio fica de fora.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| 7 testes novos com ZIPs sintéticos no layout oficial: filtragem (inativas, outra UF, sem telefone), latin1, CNPJ alfanumérico, MEI com e sem exclusão, todos os filtros da busca, importação para Contatos (nomes, MEI, telefone repetido, bloqueio, etiquetas), telefones de contador, remoção na reatualização, regras de base legal | passam; suíte completa com 40 testes |
| Velocidade com 400 mil linhas sintéticas | ~88 mil linhas/s |
| Navegador, com uma base sintética de 3.000 empresas do PR: situação da base, autocompletar de CNAE sem acento e de município, contagens (conferidas contra SQL direto), atividade secundária, importação de 3 empresas com etiquetas e lista sugeridas, layout no celular | conferido, sem erros |
| API: campanha com legítimo interesse sem frase de saída é recusada; com a frase, inicia; sem base legal, é recusada | conferido |
| **Download e leitura dos arquivos reais da Receita** | **não testado.** A rede do ambiente de desenvolvimento bloqueia o site da Receita. O primeiro teste real é a primeira atualização no seu computador. |

## Riscos e limitações

1. **Arquivos reais não testados.** O layout usado é o publicado pela Receita desde 2021, mas pode ter mudado (por exemplo, com o CNPJ alfanumérico). Se a primeira atualização falhar ou trouxer números estranhos, mande o print do cartão da base.
2. **Endereço de download incerto.** As fontes divergem sobre onde a Receita publica hoje; o endereço do compartilhamento Nextcloud veio de pesquisa e não foi confirmado. A pasta `dados-cnpj` é o caminho garantido.
3. **Download de ~7 GB a cada atualização**, mesmo para uma UF. Precisa de uns 10 GB livres no disco do Docker durante a atualização (os arquivos são lidos e apagados um a um) e de alguns GB permanentes por UF carregada.
4. **Qualidade do dado.** A Receita guarda o telefone que a empresa informou, muitas vezes desatualizado ou do contador. O filtro de telefones compartilhados reduz o problema, mas espere uma parte de números sem WhatsApp ou de outra pessoa. Por isso a verificação de WhatsApp antes da campanha é importante.
5. **Dado pessoal.** Em MEI e empresário individual, telefone e e-mail costumam ser da própria pessoa. Legítimo interesse exige relação real entre a oferta e a empresa, opção de saída em toda mensagem e atender pedidos de exclusão. A base legal escolhida fica gravada na auditoria.
6. **Risco de banimento.** Mensagem fria por WhatsApp não oficial é o cenário de maior risco. Use chips dedicados, lotes pequenos, mensagem curta e o aquecimento ligado.
7. **Uma atualização por vez**, e não há agendamento automático: a atualização mensal é feita pelo botão. Se o worker reiniciar no meio, ela é marcada como interrompida e precisa ser iniciada de novo.
8. **Busca limitada a 10.000 resultados por página**, ou seja 400 páginas de 25. Para mais, refine os filtros. A importação aceita até 5.000 empresas por vez.
9. **Licença.** Os dados são públicos da Receita Federal. Se reaproveitar dados de terceiros, como o Brasil.IO, respeite a licença deles (CC BY-SA); este sistema baixa direto da Receita.
