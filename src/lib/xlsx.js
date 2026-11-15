/**
 * Escritor mínimo de libros Excel (.xlsx, Office Open XML) sin dependencias.
 *
 * Soporta lo necesario para reportes: varias hojas, texto y números,
 * fila de encabezado en negrita con fondo, anchos de columna, panel
 * inmovilizado bajo el encabezado y autofiltro.
 *
 * Uso:
 *   buildXlsx([{ name: 'Resumen', rows: [['Ítem', 'N°'], ['Atenciones', 12]], header: true, widths: [30, 10] }])
 */
import { createZip } from './zip.js';

/** Estilos (índices en cellXfs de styles.xml). */
export const STYLE = { normal: 0, header: 1, bold: 2, title: 3 };

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Hoja del libro. Cada celda es un valor (texto, número, booleano o vacío)
 * u objeto { v, s } (s = índice de STYLE).
 * @typedef {{name: string, rows: unknown[][], header?: boolean, widths?: number[]}} Hoja
 */

/**
 * Escapa texto para XML y quita caracteres de control inválidos.
 * @param {unknown} value
 */
export function xmlEscape(value) {
  return (
    String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

/**
 * 0 -> A, 25 -> Z, 26 -> AA ...
 * @param {number} index
 */
export function columnLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Nombre de hoja válido para Excel: máx. 31 caracteres, sin []:*?/\ y único. */
/**
 * @param {unknown} name
 * @param {Set<string>} [used]
 */
export function sheetName(name, used = new Set()) {
  const base =
    String(name || 'Hoja')
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Hoja';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Normaliza una celda a { v, s }.
 * Acepta valores primitivos u objetos { v, s } (s = índice de STYLE).
 * @param {unknown} cell
 * @returns {{v: unknown, s?: number}}
 */
function normCell(cell) {
  if (cell !== null && typeof cell === 'object' && 'v' in cell) return cell;
  return { v: cell, s: STYLE.normal };
}

/**
 * @param {unknown} cell
 * @param {string} ref
 */
function cellXml(cell, ref) {
  const { v, s } = normCell(cell);
  const sAttr = s ? ` s="${s}"` : '';
  if (v === null || v === undefined || v === '') return s ? `<c r="${ref}"${sAttr}/>` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

/** @param {Hoja} sheet */
function sheetXml(sheet) {
  const rows = sheet.rows || [];
  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const header = !!sheet.header && rows.length > 0;
  const widths = sheet.widths || [];

  const cols = Array.from({ length: nCols }, (_, i) => {
    const w = widths[i] ?? autoWidth(rows, i);
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');

  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = columnLetter(c) + (r + 1);
          const cellObj = header && r === 0 ? { v: normCell(cell).v, s: STYLE.header } : cell;
          return cellXml(cellObj, ref);
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const pane = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const filter = header && rows.length > 1 ? `<autoFilter ref="A1:${columnLetter(nCols - 1)}${rows.length}"/>` : '';

  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    pane +
    `<cols>${cols}</cols>` +
    `<sheetData>${body}</sheetData>` +
    filter +
    '</worksheet>'
  );
}

/**
 * Ancho aproximado según el contenido (entre 8 y 60 caracteres).
 * @param {unknown[][]} rows
 * @param {number} col
 */
function autoWidth(rows, col) {
  let max = 8;
  for (const row of rows.slice(0, 500)) {
    const v = normCell(row[col] ?? '').v;
    const len = String(v ?? '')
      .split('\n')
      .reduce((a, l) => Math.max(a, l.length), 0);
    if (len > max) max = len;
  }
  return Math.min(60, max + 2);
}

const STYLES_XML =
  XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF0E4A6B"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * Construye un .xlsx.
 * @param {Hoja[]} sheets
 * @param {{title?: string, creator?: string, date?: Date}} [meta]
 * @returns {Uint8Array}
 */
export function buildXlsx(sheets, meta = {}) {
  if (!sheets.length) throw new Error('El libro necesita al menos una hoja');
  const used = new Set();
  const names = sheets.map((s) => sheetName(s.name, used));
  const date = meta.date || new Date();
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        names
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data:
        XML_HEAD +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlEscape(meta.title || '')}</dc:title>` +
        `<dc:creator>${xmlEscape(meta.creator || '')}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
        '</cp:coreProperties>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' +
        (sheets.some((s) => s.header && (s.rows || []).length > 1)
          ? '<definedNames>' +
            sheets
              .map((s, i) =>
                s.header && s.rows.length > 1
                  ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEscape(names[i].replace(/'/g, "''"))}'!$A$1:$${columnLetter(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>`
                  : '',
              )
              .join('') +
            '</definedNames>'
          : '') +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        names
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];

  return createZip(files, date);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
