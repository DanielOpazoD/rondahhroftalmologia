/**
 * Especialidad piloto ORL: cumple el contrato, se construye con
 * ESPECIALIDAD=orl y sus salidas (nota, Excel, seudonimización, PDF) funcionan.
 * Los registros se arman a mano: core/record.js queda ligado a la especialidad
 * activa (oftalmología) en las pruebas de Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import * as orl from '../src/specialties/orl/index.js';
import * as oftalmologia from '../src/specialties/oftalmologia/index.js';
import { validateSpecialty } from '../src/specialties/contrato.js';
import { findLeaks } from '../src/core/pseudonym.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { buildHtml } from '../scripts/build.mjs';
import { readZipWithPython, sheetCells } from './helpers.js';

const formHtml = readFileSync(new URL('../src/specialties/orl/formulario.html', import.meta.url), 'utf8');
const PROCS = structuredClone(orl.DEFAULT_PROCS);
const NOW = new Date(2026, 10, 14, 10, 30);

/** Atención ORL completa (datos ficticios). */
const fullRecord = (over = {}) => ({
  id: 'orl0001',
  checks: { antecedente_hta: true, antecedente_cirugia: true, diagnostico_hipoacusia: true, solicitado_audiometria: true },
  proc: { lavado_oido: { eye: 'OD' }, audiometria: { eye: 'AO' }, retirado: { eye: 'OI' } },
  procNames: { retirado: 'Procedimiento antiguo' },
  f: {
    operativo: 'Operativo ORL Nov 2026',
    fecha_atencion: '2026-11-14',
    paciente_nombre: 'Rosa Ejemplo Hotus',
    paciente_rut: '11.111.111-1',
    paciente_edad: '72',
    paciente_sexo: 'F',
    paciente_fono: '+56 9 8765 4321',
    antecedente_cirugia_detalle: 'Timpanoplastía OI 2015',
    antecedentes_otros: 'Hipotiroidismo',
    motivo_consulta: 'Hipoacusia bilateral. Hija Rosa acompaña, fono 987654321.',
    otoscopia_od: 'Tapón de cerumen',
    otoscopia_oi: 'Membrana timpánica íntegra',
    rinoscopia: 'Normal',
    audiometria_od: '45',
    audiometria_oi: '50 dB',
    examen_obs: 'Colaboradora',
    diagnosticos_otros: 'Acúfenos',
    ges: 'Hipoacusia bilateral',
    interconsulta: 'Fonoaudiología',
    receta: 'Gotas óticas',
    plan: 'Lavado de oído OD realizado. Audífonos vía GES.',
    seguimiento: '3 meses',
    alta: 'No',
    medico_nombre: 'Dra. Ana Pérez Soto',
    medico_rut: '22.222.222-2',
  },
  ...over,
});
const minimal = (id, f = {}, extra = {}) => ({ id, checks: {}, proc: {}, f: { fecha_atencion: '2026-11-15', ...f }, ...extra });

test('ORL cumple el contrato de especialidad', () => {
  assert.deepEqual(validateSpecialty(orl, { formHtml }), []);
  assert.deepEqual(orl.ESPECIALIDAD, { id: 'orl', nombre: 'Otorrinolaringología', prefijo: 'orl_' });
  assert.notEqual(orl.ESPECIALIDAD.prefijo, oftalmologia.ESPECIALIDAD.prefijo, 'datos del navegador separados');
});

test('ORL no depende del módulo de oftalmología ni de la interfaz', () => {
  const dir = new URL('../src/specialties/orl/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(!/from '[^']*(oftalmologia|activa|ui)\//.test(src), `${name} importa otra especialidad o la interfaz`);
  }
});

test('el formulario ORL tiene cada id que usa la interfaz', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8') + formHtml;
  const uiDir = new URL('../src/ui/', import.meta.url);
  const sources = readdirSync(uiDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(new URL(f, uiDir), 'utf8'));
  sources.push(readFileSync(new URL('../src/main.js', import.meta.url), 'utf8'));
  const ids = new Set(sources.flatMap((s) => [...s.matchAll(/\$\('#([A-Za-z0-9_]+)/g)].map((m) => m[1])));
  assert.deepEqual(
    [...ids].filter((id) => !html.includes(`id="${id}"`)),
    [],
  );
});

test('ESPECIALIDAD=orl construye la app con el formulario ORL y sin plantilla', async () => {
  const prev = process.env.ESPECIALIDAD;
  process.env.ESPECIALIDAD = 'orl';
  try {
    const html = await buildHtml();
    for (const id of ['otoscopia_od', 'otoscopia_oi', 'rinoscopia', 'audiometria_od', 'plan']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(!html.includes('id="od_pio"'), 'sin campos de oftalmología');
    assert.ok(!html.includes('JVBERi0'), 'sin plantilla PDF incrustada');
    assert.ok(html.includes('Rinosinusitis'), 'catálogos ORL en el código');
  } finally {
    if (prev === undefined) delete process.env.ESPECIALIDAD;
    else process.env.ESPECIALIDAD = prev;
  }
});

test('casos de ejemplo usan solo catálogos, campos y lados de ORL', () => {
  const keys = new Set([...orl.ANTECEDENTES, ...orl.SOLICITADOS, ...orl.DIAGNOSTICOS].map((d) => d.key));
  for (const c of orl.casosDeEjemplo()) {
    for (const k of Object.keys(c.f)) assert.ok(orl.TEXT_FIELDS.includes(k), k);
    for (const k of Object.keys(c.checks)) assert.ok(keys.has(k), k);
    for (const [id, p] of Object.entries(c.proc)) {
      assert.ok(
        PROCS.some((x) => x.id === id),
        id,
      );
      assert.ok(orl.OJOS.includes(p.eye), p.eye);
    }
  }
});

test('validación clínica: audiometría fuera de rango e hipoacusia sin audiometría', () => {
  const run = (rec) => {
    const fields = {};
    const notes = [];
    orl.validarClinico(
      rec,
      (k, m) => (fields[k] = m),
      (m) => notes.push(m),
    );
    return { fields, notes };
  };
  assert.deepEqual(run(fullRecord()), { fields: {}, notes: [] });
  const bad = run(minimal('v', { audiometria_od: '130', audiometria_oi: 'abc' }, { checks: { diagnostico_hipoacusia: true } }));
  assert.match(bad.fields.audiometria_od, /fuera de rango/);
  assert.match(bad.fields.audiometria_oi, /fuera de rango/);
  assert.deepEqual(run(minimal('w', {}, { checks: { diagnostico_hipoacusia: true } })).notes, [
    'Hipoacusia sin audiometría registrada ni solicitada',
  ]);
  assert.deepEqual(run({ checks: { diagnostico_hipoacusia: true }, proc: { audiometria: { eye: 'AO' } } }).notes, []);
});

test('lados: coversEye y procedimientos realizados en orden de la lista', () => {
  assert.ok(orl.coversEye('AO', 'od') && orl.coversEye('OI', 'oi') && !orl.coversEye('OD', 'oi') && !orl.coversEye(undefined, 'od'));
  assert.deepEqual(
    orl.proceduresDone(fullRecord(), PROCS).map((p) => [p.nombre, p.lado, p.oidos]),
    [
      ['Lavado de oído', 'OD', 1],
      ['Audiometría tonal', 'AO', 2],
    ],
    'el procedimiento que ya no está en la lista no se muestra',
  );
  assert.equal(orl.procName('x', {}, PROCS), 'x');
  assert.equal(orl.sideCount(''), 0);
});

test('nota ORL para la ficha', () => {
  const note = orl.buildNote(fullRecord(), PROCS, { pie: '(pie)' });
  assert.ok(note.startsWith('ATENCIÓN OTORRINOLARINGOLÓGICA – RONDAS Y OPERATIVOS (Operativo ORL Nov 2026)'));
  for (const s of [
    'Fecha: 14-11-2026',
    'Paciente: Rosa Ejemplo Hotus | RUT 11.111.111-1 | 72 años | Femenino | Fono +56 9 8765 4321',
    'ANTECEDENTES: HTA, Cx: Timpanoplastía OI 2015, Hipotiroidismo',
    'Otoscopía OD: Tapón de cerumen',
    'Audiometría (PTP): OD 45 dB / OI 50 dB',
    '- Lavado de oído OD',
    'EXÁMENES SOLICITADOS: Audiometría',
    '- Hipoacusia',
    '- Acúfenos',
    'GES: Hipoacusia bilateral | IC: Fonoaudiología | Receta: Gotas óticas',
    'Seguimiento: 3 meses\nAlta: No',
    'Dra. Ana Pérez Soto – RUT 22.222.222-2',
  ]) {
    assert.ok(note.includes(s), `falta «${s}» en:\n${note}`);
  }
  assert.ok(note.endsWith('(pie)'));
  assert.ok(!/PIO|ojo|AV /i.test(note), 'sin conceptos de oftalmología');
  assert.equal(
    orl.buildNote(minimal('m'), PROCS),
    'ATENCIÓN OTORRINOLARINGOLÓGICA – RONDAS Y OPERATIVOS\nFecha: 15-11-2026\n\nANTECEDENTES: No refiere',
  );
});

test('estadística ORL: misma forma que la que lee la interfaz (ui/statsView.js)', () => {
  const recs = [
    fullRecord(),
    minimal(
      'b',
      { paciente_nombre: 'Juan Prueba', paciente_edad: '8', paciente_sexo: 'M', procedimientos_otros: 'Cultivo' },
      { proc: { lavado_oido: { eye: 'AO' } } },
    ),
    minimal('c', {}, { checks: { diagnostico_rinitis: true } }),
  ];
  const S = orl.computeStats(recs, PROCS);
  const O = oftalmologia.computeStats([], oftalmologia.DEFAULT_PROCS);
  assert.deepEqual(Object.keys(S).sort(), Object.keys(O).sort());
  assert.deepEqual(Object.keys(S.gest), Object.keys(O.gest));
  assert.deepEqual(S.proc['Lavado de oído'], { pac: 2, od: 2, oi: 1, ojos: 3 });
  assert.equal(S.ojos, 5); // sin el procedimiento que ya no está en la lista
  assert.equal(S.pacientes, 3);
  assert.deepEqual(S.sol, { Audiometría: 1, Otros: 1 });
  assert.equal(S.dx['Otros diagnósticos'], 1);
  assert.equal(S.edadSexo['5-14'].M, 1);
  assert.deepEqual(orl.ageGroupLabels(), ['0-4', '5-14', '15-44', '45-64', '65+', 'Sin dato']);
  assert.deepEqual(
    S.porDia.map((d) => [d.fecha, d.atenciones]),
    [
      ['2026-11-14', 1],
      ['2026-11-15', 2],
    ],
  );
  assert.deepEqual(orl.operativosOf(recs), ['Operativo ORL Nov 2026']);
  assert.equal(orl.filterRecords(recs, { desde: '2026-11-15' }).length, 2);
  assert.equal(orl.computeStats([], PROCS).edad.promedio, null);
});

test('Excel de estadística ORL: libro válido con sus hojas', () => {
  const recs = [fullRecord(), minimal('b', { paciente_nombre: 'Juan Prueba' })];
  const sheets = orl.statsWorkbook(recs, PROCS, { operativo: 'Operativo ORL Nov 2026' }, NOW);
  assert.deepEqual(
    sheets.map((s) => s.name),
    ['Resumen', 'Atenciones', 'Prestaciones'],
  );
  const files = readZipWithPython(buildXlsx(sheets));
  const resumen = Object.values(sheetCells(files['xl/worksheets/sheet1.xml']));
  assert.ok(resumen.includes('Otorrinolaringología · Rondas y operativos — Hospital Hanga Roa'));
  assert.ok(!resumen.some((v) => /Oftalm/i.test(v)), 'sin el nombre de oftalmología');
  const at = sheetCells(files['xl/worksheets/sheet2.xml']);
  assert.ok(Object.values(at).includes('Otoscopía OD') && Object.values(at).includes('Tapón de cerumen'));
  assert.equal(sheets[1].rows[1][14], 45, 'audiometría como número');
  assert.equal(sheets[1].rows[1][15], '50 dB', 'texto no numérico se conserva');
  assert.deepEqual(sheets[2].rows[1].slice(7, 10), ['Lavado de oído', 'OD', 1]);
});

test('seudonimización ORL: sin identificadores, con códigos y diccionario', () => {
  const recs = [fullRecord(), minimal('b', { paciente_nombre: 'Juan Prueba', paciente_edad: '40' })];
  const res = orl.anonymizeRecords(recs, PROCS, { secret: 'c'.repeat(64) });
  assert.deepEqual(findLeaks(JSON.stringify(res.registros), recs), []);
  const r = res.registros[0];
  assert.match(r.codigo_paciente, /^P-/);
  assert.equal(r.mes, '2026-11');
  assert.equal(r.edad, '70-74');
  assert.deepEqual(r.procedimientos_realizados[0], { procedimiento: 'Lavado de oído', oido: 'OD' });
  assert.match(r.motivo_consulta, /\[NOMBRE\].*\[NÚMERO\]/);
  assert.equal(r.audiometria_od_db, '45');
  assert.equal(res.correspondencia.length, 2);

  const json = orl.anonymizedJson(res, NOW);
  assert.equal(json.n_atenciones, 2);
  assert.match(json.descripcion, /otorrinolaringología/);
  const sheets = orl.anonymizedSheets(res, PROCS, NOW);
  assert.equal(sheets[0].rows.length, 3);
  readZipWithPython(buildXlsx(sheets));

  const sinTexto = orl.anonymizeRecords(recs, PROCS, { secret: 'c'.repeat(64), texto: 'excluir', fechas: 'omitir' });
  assert.equal(sinTexto.registros[0].motivo_consulta, undefined);
  assert.equal(sinTexto.registros[0].mes, undefined);
  const head = orl.anonymizedSheets(sinTexto, PROCS, NOW)[0].rows[0];
  assert.ok(!head.includes('plan') && !head.includes('Mes'));
});

/** Textos dibujados en un PDF de pdf-lib (cadenas hex de los flujos de contenido). */
function pdfStrings(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const out = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try {
      content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      content = m[1];
    }
    for (const h of content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) out.push(Buffer.from(h[1], 'hex').toString('latin1'));
  }
  return out.join('\n');
}

test('PDF ORL dibujado desde cero: título, paciente, examen, plan y pie', async () => {
  assert.equal(orl.pdfFileName(fullRecord()), 'ORL_2026-11-14_11111111-1_Rosa_Ejemplo_Hotus.pdf');
  assert.equal(orl.pdfFileName({ f: {} }), 'ORL_sin_fecha_paciente.pdf');
  const r = await orl.buildAttentionPdf(new Uint8Array(), fullRecord(), PROCS, { now: NOW });
  assert.equal(r.pages, 1);
  assert.deepEqual(r.overflow, []);
  const doc = await PDFDocument.load(r.bytes);
  assert.match(doc.getTitle(), /Otorrinolaringolog.a - Rosa Ejemplo Hotus - 14-11-2026/);
  const text = pdfStrings(r.bytes);
  for (const s of [
    'HOJA DE ATENCIÓN OTORRINOLARINGOLOGÍA',
    'Rosa Ejemplo Hotus',
    'Otoscopía OD: Tapón de cerumen',
    '- Lavado de oído OD',
    'Lavado de oído OD realizado. Audífonos vía GES.',
    'Dra. Ana Pérez Soto - RUT 22.222.222-2',
    'Página 1 de 1',
  ]) {
    assert.ok(text.includes(s), `falta «${s}»`);
  }

  // Texto largo: pasa a páginas nuevas, sin recortar.
  const long = await orl.buildAttentionPdf(
    null,
    fullRecord({ id: undefined, f: { ...fullRecord().f, plan: 'Indicación larga. '.repeat(400) } }),
    PROCS,
    {
      footer: false,
      now: NOW,
    },
  );
  assert.ok(long.pages >= 2);
  assert.ok(!pdfStrings(long.bytes).includes('Página 1'), 'sin pie');
  // Atención casi vacía: igual produce una hoja válida.
  const empty = await orl.buildAttentionPdf(null, minimal('e'), PROCS, { now: NOW });
  assert.ok(pdfStrings(empty.bytes).includes('Firma'));
});
