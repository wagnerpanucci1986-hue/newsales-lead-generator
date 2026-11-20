import { getSetting } from '../lib/settings.js';
import { createMessage } from './model.js';

const VAR = /\{\{\s*[^}]+?\s*\}\}/g;

/**
 * Pede ao Claude versões diferentes da 1ª mensagem da campanha, com o mesmo sentido.
 * Devolve também avisos: variável ou frase de saída que sumiu numa variação.
 */
export async function generateVariations(body: string, count: number): Promise<{ variations: string[]; warnings: string[] }> {
  const cfg = await getSetting('sdr');
  const optOut = await getSetting('optOut');
  const res = await createMessage({
    model: cfg.model,
    max_tokens: 6000,
    output_config: {
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: { type: 'object', additionalProperties: false, properties: { variacoes: { type: 'array', items: { type: 'string' } } }, required: ['variacoes'] },
      },
    },
    system: `Você escreve variações da primeira mensagem de prospecção da New Sales pelo WhatsApp, para que nenhuma mensagem saia idêntica a outra (o que ajuda a evitar bloqueios).
Regras para cada variação:
- Mesmo sentido, mesmo convite e mesmo tom da original; mude a abertura, a ordem e as palavras.
- Até 3 linhas, uma pergunta só.
- Mantenha exatamente as variáveis entre chaves duplas, como {{primeiro_nome}}, sem traduzir nem inventar novas.
- Se a original disser como parar de receber mensagens, toda variação também diz, com a mesma palavra (${optOut.keywords[0] ?? 'SAIR'}).
- Não use spintax ({a|b}), não prometa resultado, não cite valores, não use "consultoria".
- No máximo um emoji, e só se a original tiver.`,
    messages: [{ role: 'user', content: `Escreva ${count} variações desta mensagem:\n\n${body}` }],
  });
  if (res.stop_reason === 'refusal') throw new Error('O modelo não gerou variações para esta mensagem.');
  const text = res.content.find((b) => b.type === 'text');
  const parsed = JSON.parse(text && text.type === 'text' ? text.text : '{}') as { variacoes?: string[] };
  const variations = (parsed.variacoes ?? []).map((v) => v.trim()).filter(Boolean).slice(0, count);

  const warnings: string[] = [];
  const vars = [...new Set(body.match(VAR) ?? [])].map((v) => v.replace(/\s/g, ''));
  const keyword = optOut.keywords.find((k) => body.toUpperCase().includes(k.toUpperCase()));
  variations.forEach((v, i) => {
    const has = new Set((v.match(VAR) ?? []).map((x) => x.replace(/\s/g, '')));
    const missing = vars.filter((x) => !has.has(x));
    if (missing.length) warnings.push(`Variação ${i + 1} perdeu ${missing.join(', ')}.`);
    if (keyword && !v.toUpperCase().includes(keyword.toUpperCase())) warnings.push(`Variação ${i + 1} não diz como sair (${keyword}).`);
  });
  return { variations, warnings };
}
