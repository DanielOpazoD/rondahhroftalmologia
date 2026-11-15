import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as oftalmologia from '../src/specialties/oftalmologia/index.js';
import { validateSpecialty } from '../src/specialties/contrato.js';

const formHtml = readFileSync(new URL('../src/specialties/oftalmologia/formulario.html', import.meta.url), 'utf8');

test('oftalmología cumple el contrato de especialidad', () => {
  assert.deepEqual(validateSpecialty(oftalmologia, { formHtml }), []);
});

test('el contrato detecta especialidades mal configuradas', () => {
  const bad = {
    ...oftalmologia,
    ESPECIALIDAD: { id: 'Otorrino!', nombre: '', prefijo: 'otorrino' },
    DIAGNOSTICOS: [...oftalmologia.DIAGNOSTICOS, { key: 'antecedente_hta', label: 'Repetida' }],
    TEXT_FIELDS: oftalmologia.TEXT_FIELDS.filter((f) => f !== 'paciente_rut').concat('campo_sin_etiqueta'),
    buildNote: undefined,
  };
  const problems = validateSpecialty(bad, { formHtml });
  for (const expected of [
    /ESPECIALIDAD\.id/,
    /ESPECIALIDAD\.nombre/,
    /prefijo/,
    /repetida: antecedente_hta/,
    /incluir "paciente_rut"/,
    /etiqueta .*campo_sin_etiqueta/,
    /buildNote/,
    /id="campo_sin_etiqueta"/,
  ]) {
    assert.ok(
      problems.some((x) => expected.test(x)),
      `falta detectar ${expected}`,
    );
  }
});
