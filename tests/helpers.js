/**
 * Utilidades de prueba: leer ZIP/XLSX con el `zipfile` de Python (lector
 * independiente de nuestro escritor, para no "probarnos a nosotros mismos").
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Abre un ZIP con Python y devuelve {nombre: contenido-texto}.
 * Python valida CRC y estructura (testzip) y que cada .xml sea XML bien formado.
 */
export function readZipWithPython(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'oft-test-'));
  const file = join(dir, 'f.zip');
  writeFileSync(file, bytes);
  const script = `
import sys, zipfile, json, xml.dom.minidom
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
if bad: raise SystemExit('CRC inválido en ' + bad)
out = {}
for n in z.namelist():
    data = z.read(n)
    if n.endswith('.xml') or n.endswith('.rels'):
        xml.dom.minidom.parseString(data)
    try: out[n] = data.decode('utf-8')
    except UnicodeDecodeError: out[n] = '<binario %d bytes>' % len(data)
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Extrae los textos de celdas (inlineStr y números) de una hoja XML. */
export function sheetCells(xml) {
  const cells = {};
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
    const inner = m[2] || '';
    const t = inner.match(/<t[^>]*>(.*?)<\/t>/s) || inner.match(/<v>(.*?)<\/v>/);
    if (t) {
      cells[m[1]] = t[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
    }
  }
  return cells;
}
