import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePhone } from '../src/lib/phone.js';
import { renderTemplate, spin, usedVariables } from '../src/lib/template.js';

test('telefones brasileiros são normalizados para 55 + DDD + número', () => {
  const ok = (input: string) => {
    const r = normalizePhone(input);
    return r.ok ? r.phone : `erro: ${r.reason}`;
  };
  assert.equal(ok('(11) 98888-7777'), '5511988887777');
  assert.equal(ok('+55 11 98888-7777'), '5511988887777');
  assert.equal(ok('5511988887777'), '5511988887777');
  assert.equal(ok('011 98888 7777'), '5511988887777');
  assert.equal(ok('11 8888-7777'), '5511988887777', 'celular antigo sem o 9 é completado');
  assert.equal(ok('(11) 3333-4444'), '551133334444', 'fixo é mantido');
  assert.equal(ok('+1 415 555 2671'), '14155552671');
  for (const bad of ['', 'abc', '1234', '(00) 98888-7777', '(11) 88888-7777', '5511988887777123', '4411988887777']) {
    assert.equal(normalizePhone(bad).ok, false, `deveria rejeitar "${bad}"`);
  }
});

test('spintax sorteia opções, inclusive aninhadas, e preserva variáveis', () => {
  assert.equal(spin('{Olá|Oi|E aí}, tudo bem?', () => 0), 'Olá, tudo bem?');
  assert.equal(spin('{Olá|Oi|E aí}, tudo bem?', () => 0.99), 'E aí, tudo bem?');
  assert.equal(spin('{Bom {dia|tarde}|Oi} {{nome}}', () => 0), 'Bom dia {{nome}}');
  const seen = new Set(Array.from({ length: 200 }, () => spin('{a|b|c}')));
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('variáveis usam cadastro, campos personalizados e somem quando vazias', () => {
  const contact = { name: 'Maria Souza', company: 'ACME', phone: '5511988887777', customFields: { Cidade: 'São Paulo', 'Plano Atual': 'Pro' } };
  assert.equal(renderTemplate('Oi {{primeiro_nome}} da {{ Empresa }}, de {{cidade}} ({{plano atual}})', contact), 'Oi Maria da ACME, de São Paulo (Pro)');
  assert.equal(renderTemplate('Olá {{nome}}, tudo bem?', { phone: '55', name: null }), 'Olá, tudo bem?');
  assert.equal(renderTemplate('Olá {{nome}}', { phone: '55', pushName: 'Zé' }), 'Olá Zé');
  // valor do contato com chaves não vira spintax
  assert.equal(renderTemplate('{Oi|Olá} {{nome}}', { phone: '55', name: '{a|b}' }, () => 0), 'Oi {a|b}');
  assert.deepEqual(usedVariables('{{Nome}} {{ cidade }} {{nome}}'), ['nome', 'cidade']);
});
