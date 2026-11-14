import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export interface Sheet {
  headers: string[];
  rows: string[][];
}

const MAX_ROWS = 200_000;

function decode(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8').replace(/^﻿/, '');
  // CSV exportado pelo Excel no Brasil costuma vir em Latin-1.
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

function detectDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/** Lê CSV (vírgula, ponto e vírgula ou tab) ou XLSX. A primeira linha é o cabeçalho. */
export async function parseSpreadsheet(buffer: Buffer, fileName: string): Promise<Sheet> {
  let table: string[][];
  if (/\.xlsx$/i.test(fileName)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('A planilha não tem nenhuma aba');
    table = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = (cell.text ?? '').toString().trim();
      });
      table.push(Array.from(cells, (c) => c ?? ''));
    });
  } else if (/\.(csv|txt)$/i.test(fileName)) {
    const text = decode(buffer);
    table = parse(text, {
      delimiter: detectDelimiter(text.split(/\r?\n/, 1)[0] ?? ''),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }) as string[][];
  } else {
    throw new Error('Formato não suportado. Envie um arquivo .csv ou .xlsx');
  }

  if (table.length < 2) throw new Error('O arquivo precisa ter o cabeçalho e ao menos uma linha de dados');
  if (table.length - 1 > MAX_ROWS) throw new Error(`O arquivo tem mais de ${MAX_ROWS.toLocaleString('pt-BR')} linhas; divida em partes`);
  const headers = table[0]!.map((h, i) => h || `Coluna ${i + 1}`);
  return { headers, rows: table.slice(1) };
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palpite inicial de mapeamento a partir do nome da coluna. */
export function suggestMapping(headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const header of headers) {
    const h = strip(header);
    let target = `custom:${header}`;
    if (/(telefone|celular|whats|fone|phone|numero|mobile)/.test(h)) target = 'phone';
    else if (/^(nome|name|contato|cliente)/.test(h)) target = 'name';
    else if (/(empresa|company|organizacao|razao)/.test(h)) target = 'company';
    else if (/e-?mail/.test(h)) target = 'email';
    if (!target.startsWith('custom:')) {
      if (used.has(target)) target = `custom:${header}`;
      else used.add(target);
    }
    out[header] = target;
  }
  return out;
}
