import { parse } from 'csv-parse';
import yauzl from 'yauzl';
import type { Readable } from 'node:stream';

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => (err ? reject(err) : resolve(zip))));
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))));
}

/**
 * Lê, em streaming, todos os CSVs de um ZIP da Receita (latin1, ";", aspas).
 * Linhas malformadas são puladas em vez de interromper a importação.
 */
export async function* readZipCsv(path: string): AsyncGenerator<string[]> {
  const zip = await openZip(path);
  try {
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const onEntry = (e: yauzl.Entry) => {
          zip.off('end', onEnd);
          zip.off('error', onError);
          resolve(e);
        };
        const onEnd = () => {
          zip.off('entry', onEntry);
          zip.off('error', onError);
          resolve(null);
        };
        const onError = (err: Error) => {
          zip.off('entry', onEntry);
          zip.off('end', onEnd);
          reject(err);
        };
        zip.once('entry', onEntry);
        zip.once('end', onEnd);
        zip.once('error', onError);
        zip.readEntry();
      });
      if (!entry) return;
      if (entry.fileName.endsWith('/')) continue;
      const parser = (await entryStream(zip, entry)).pipe(
        parse({
          delimiter: ';',
          quote: '"',
          encoding: 'latin1',
          relax_quotes: true,
          relax_column_count: true,
          skip_records_with_error: true,
          skip_empty_lines: true,
        }),
      );
      for await (const record of parser) yield record as string[];
    }
  } finally {
    zip.close();
  }
}
