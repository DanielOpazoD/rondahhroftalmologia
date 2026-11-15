import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPracticeData } from '../src/core/demo.js';
import { casosDeEjemplo } from '../src/specialties/activa/index.js';
import { isAttended, attentionsOf } from '../src/core/patient.js';
import { isValidRut } from '../src/core/format.js';
import { validateRecord } from '../src/core/record.js';

test('datos de práctica: lista del día con pendientes, historial y datos válidos', () => {
  const d = buildPracticeData({ today: '2026-11-15', now: 1_800_000_000_000, casos: casosDeEjemplo() });
  const hoy = d.records.filter((r) => r.f.fecha_atencion === '2026-11-15');
  assert.equal(hoy.length, 6);
  assert.equal(hoy.filter(isAttended).length, 1);
  assert.equal(hoy.filter((r) => !isAttended(r)).length, 5);
  const ana = d.records.find((r) => r.f.paciente_nombre === 'Ana Ejemplo Pakarati');
  assert.equal(attentionsOf(d.records, ana.pacienteId).length, 2, 'con historial');
  for (const r of d.records) {
    assert.ok(isValidRut(r.f.paciente_rut));
    assert.deepEqual(validateRecord(r).errors, []);
    assert.ok(r.pacienteId && r.f.paciente_edad);
  }
  assert.deepEqual(
    d.medicos.map((m) => m.rol),
    ['medico', 'enfermeria', 'admision'],
  );
});
