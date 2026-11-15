import { test, describe } from 'node:test';
import { SCHEMA_VERSION } from '../src/config/catalogs.js';
import assert from 'node:assert/strict';
import {
  fmtDate,
  isIsoDate,
  todayIso,
  daysBetween,
  isValidRut,
  formatRut,
  rutKey,
  rutCheckDigit,
  toWinAnsi,
  fileSafe,
  normalizeText,
  parseNumber,
  doctorName,
  escapeHtml,
} from '../src/core/format.js';
import { blankRecord, normalizeRecord, validateRecord, patientKey, findDuplicate, sortRecords, newRecordId } from '../src/core/record.js';
import {
  proceduresDone,
  pioFor,
  procLabel,
  diagnosesList,
  requestedList,
  antecedentsList,
  eyeCount,
} from '../src/specialties/oftalmologia/clinica.js';
import { buildNote } from '../src/specialties/oftalmologia/nota.js';
import { fullRecord, minimalRecord, PROCS } from './fixtures.js';

describe('format', () => {
  test('fechas', () => {
    assert.equal(fmtDate('2026-11-14'), '14-11-2026');
    assert.equal(fmtDate(''), '');
    assert.equal(fmtDate('2026-02-30'), '');
    assert.ok(isIsoDate('2024-02-29'));
    assert.ok(!isIsoDate('2025-02-29'));
    assert.equal(todayIso(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(daysBetween('2026-11-14', '2026-11-16'), 2);
    assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
  });

  test('RUT: dígito verificador, formato y clave', () => {
    assert.equal(rutCheckDigit('12345678'), '5');
    assert.equal(rutCheckDigit('11111111'), '1');
    assert.ok(isValidRut('12.345.678-5'));
    assert.ok(isValidRut('123456785'));
    assert.ok(!isValidRut('12.345.678-4'));
    assert.ok(!isValidRut('K'));
    assert.ok(isValidRut('10.000.013-K'), 'DV K');
    assert.equal(formatRut('123456785'), '12.345.678-5');
    assert.equal(formatRut('10000013k'), '10.000.013-K');
    assert.equal(formatRut('abc'), 'abc');
    assert.equal(rutKey('12.345.678-5'), '12345678-5');
    assert.equal(rutKey('012345678-5'), '12345678-5');
  });

  test('texto', () => {
    assert.equal(toWinAnsi('“Hola” – ok… ≥ 5 • ✓'), '"Hola" - ok... >= 5 - ');
    assert.equal(toWinAnsi('Ñandú'), 'Ñandú');
    assert.equal(fileSafe('María José Pérez/Ñ'), 'Maria_Jose_Perez_N');
    assert.equal(fileSafe(''), 'sin_nombre');
    assert.equal(normalizeText('  JOSÉ   Pérez '), 'jose perez');
    assert.equal(parseNumber('14,5'), 14.5);
    assert.equal(parseNumber('14 Apl'), null);
    assert.equal(doctorName('Ana Pérez'), 'Dr(a). Ana Pérez');
    assert.equal(doctorName('Dra. Ana Pérez'), 'Dra. Ana Pérez');
    assert.equal(doctorName(''), '');
    assert.equal(escapeHtml(`<img src=x onerror="a">'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;');
  });
});

describe('record', () => {
  test('blankRecord recuerda médico y operativo', () => {
    const r = blankRecord({ n: 'Ana', r: '1-9', op: 'Op 1' }, new Date(2026, 10, 14));
    assert.equal(r.f.medico_nombre, 'Ana');
    assert.equal(r.f.operativo, 'Op 1');
    assert.equal(r.f.fecha_atencion, '2026-11-14');
    assert.equal(r.id, null);
  });

  test('normalizeRecord migra registros v1 incompletos sin perder datos', () => {
    const v1 = {
      id: 'a1',
      f: { paciente_nombre: 'X', paciente_edad: 70, nulo: null },
      proc: { fo: { eye: 'AO' }, malo: { eye: 'XX' } },
      cat: 'ZZ',
    };
    const r = normalizeRecord(v1);
    assert.equal(r.v, SCHEMA_VERSION);
    assert.equal(r.especialidad, 'oftalmologia', 'datos antiguos quedan en oftalmología');
    assert.equal(r.f.paciente_edad, '70');
    assert.ok(!('nulo' in r.f));
    assert.deepEqual(Object.keys(r.proc), ['fo']);
    assert.equal(r.cat, '');
    assert.deepEqual(r.checks, {});
    assert.equal(v1.f.paciente_edad, 70, 'no muta el original');
    assert.equal(normalizeRecord(null).id, null);
    assert.equal(normalizeRecord({ id: '<script>' }).id, null, 'id con caracteres inseguros se anula');
    assert.equal(normalizeRecord({ id: 'amhz3k2a9x1' }).id, 'amhz3k2a9x1');
  });

  test('validateRecord: errores bloquean, advertencias no', () => {
    const now = new Date(2026, 10, 14);
    const empty = validateRecord(minimalRecord('x', { fecha_atencion: '' }), now);
    assert.equal(empty.errors.length, 2);
    assert.equal(empty.fields.paciente_nombre.level, 'error');

    const ok = validateRecord(fullRecord(), now);
    assert.deepEqual(ok.errors, []);
    assert.ok(
      ok.warnings.some((w) => /fuera de rango/.test(w)),
      'PIO 99 de un procedimiento',
    );

    const bad = validateRecord(
      minimalRecord(
        'y',
        { paciente_nombre: 'A', paciente_rut: '12.345.678-4', paciente_edad: '200', od_pio: '120', fecha_atencion: '2026-12-01' },
        { checks: { diagnostico_catarata: true } },
      ),
      now,
    );
    assert.deepEqual(bad.errors, []);
    for (const k of ['paciente_rut', 'paciente_edad', 'od_pio', 'fecha_atencion', 'catSeg']) assert.equal(bad.fields[k]?.level, 'warn', k);
  });

  test('patientKey prioriza RUT y normaliza nombre', () => {
    assert.deepEqual(patientKey(minimalRecord('a', { paciente_rut: '12.345.678-5', paciente_nombre: 'X' })), {
      key: 'rut:12345678-5',
      basis: 'rut',
    });
    assert.equal(patientKey(minimalRecord('a', { paciente_nombre: 'José  PÉREZ' })).key, 'nombre:jose perez');
    assert.equal(patientKey(minimalRecord('z')).basis, 'id');
  });

  test('findDuplicate detecta mismo paciente y fecha', () => {
    const a = minimalRecord('a', { paciente_rut: '12345678-5' });
    const b = minimalRecord(null, { paciente_rut: '12.345.678-5' });
    const c = minimalRecord(null, { paciente_rut: '12.345.678-5', fecha_atencion: '2026-11-15' });
    assert.equal(findDuplicate(b, [a])?.id, 'a');
    assert.equal(findDuplicate(c, [a]), undefined);
    assert.equal(findDuplicate(a, [a]), undefined, 'no se compara consigo mismo');
  });

  test('sortRecords y newRecordId', () => {
    const s = sortRecords([minimalRecord('a', { fecha_atencion: '2026-01-01' }), minimalRecord('b', { fecha_atencion: '2026-02-01' })]);
    assert.deepEqual(
      s.map((r) => r.id),
      ['b', 'a'],
    );
    assert.match(
      newRecordId(1000, () => 0.123456),
      /^a[0-9a-z]+$/,
    );
  });
});

describe('clinical', () => {
  test('proceduresDone: orden de la lista, PIO solo del ojo cubierto', () => {
    const done = proceduresDone(fullRecord(), PROCS);
    assert.deepEqual(
      done.map((p) => p.id),
      ['autorref', 't_aplan', 't_neum', 'fo', 'oct'],
    );
    const neum = done.find((p) => p.id === 't_neum');
    assert.equal(neum.pioOd, '18');
    assert.equal(neum.pioOi, '', 'OI ignorado porque se hizo solo OD');
    assert.equal(procLabel(done[1]), 'T. Aplanática AO (OD 14 / OI 16 mmHg)');
    assert.equal(
      done.reduce((a, p) => a + p.ojos, 0),
      2 + 2 + 1 + 2 + 1,
    );
    assert.equal(eyeCount('XX'), 0);
  });

  test('procedimiento que ya no está en la lista conserva su nombre guardado', () => {
    const r = minimalRecord('a', {}, { proc: { viejo: { eye: 'OD', od: '20' } }, procNames: { viejo: 'Tonometría antigua' } });
    const [p] = proceduresDone(r, PROCS);
    assert.equal(p.nombre, 'Tonometría antigua');
    assert.equal(p.pioOd, '20');
  });

  test('pioFor usa el examen o la primera tonometría con sufijo', () => {
    const r = fullRecord();
    assert.equal(pioFor(r, 'od', PROCS), '14 Apl');
    r.f.od_pio = '21';
    assert.equal(pioFor(r, 'od', PROCS), '21');
  });

  test('listas legibles', () => {
    const r = fullRecord();
    assert.deepEqual(antecedentsList(r), ['DM2', 'HTA', 'Cx: Facoemulsificación OI 2019', 'Hipotiroidismo']);
    assert.deepEqual(diagnosesList(r), ['RDNP', 'Catarata OD', 'Blefaritis crónica']);
    assert.deepEqual(requestedList(r, { withOthers: false }), ['OCT', 'Test Schirmer']);
  });

  test('buildNote incluye las secciones y no deja "undefined"', () => {
    const note = buildNote(fullRecord(), PROCS, { pie: '(pie)' });
    for (const s of [
      'ATENCIÓN OFTALMOLÓGICA',
      'Fecha: 14-11-2026',
      'Femenino',
      'ANTECEDENTES: DM2',
      'EXAMEN FÍSICO:',
      'OD: AV 20/80 | PIO 14 Apl',
      'PROCEDIMIENTOS REALIZADOS:',
      '- T. Neumática OD (OD 18 mmHg)',
      'DIAGNÓSTICOS:',
      'GES: Catarata',
      'Dra. Ana Pérez Soto – RUT 22.222.222-2',
      '(pie)',
    ]) {
      assert.ok(note.includes(s), `falta: ${s}`);
    }
    assert.ok(!/undefined|null/.test(note));
    assert.ok(!/\n{3,}/.test(note));
    const minimal = buildNote(minimalRecord('m', { paciente_nombre: 'Solo Nombre' }), PROCS);
    assert.ok(minimal.includes('ANTECEDENTES: No refiere'));
    assert.ok(!minimal.includes('PROCEDIMIENTOS'));
  });
});
