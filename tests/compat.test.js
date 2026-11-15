import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unknownFields } from '../src/core/compat.js';
import { makeMedico, makeOperativo } from '../src/core/catalog.js';
import { normalizePatient } from '../src/core/patient.js';
import { normalizeRecord } from '../src/core/record.js';
import { syncMerge, mergeRecords } from '../src/core/merge.js';
import { memoryStorage, createStore } from '../src/storage/store.js';
import { minimalRecord } from './fixtures.js';

test('unknownFields: conserva datos desconocidos seguros y descarta lo peligroso', () => {
  const obj = JSON.parse('{"a":1,"nuevo":"x","lista":[1,"2"],"obj":{"k":true},"__proto__":{"p":1},"mala clave":1}');
  obj.fn = () => 1;
  assert.deepEqual(unknownFields(obj, ['a']), { nuevo: 'x', lista: [1, '2'], obj: { k: true } });
  assert.equal({}.p, undefined, 'sin contaminar prototipos');
});

test('perfiles y operativos de una versión más nueva conservan sus campos al pasar por esta', () => {
  const futuro = { id: 'm_abcdefgh', nombre: 'Kine Uno', rol: 'kinesiologo', especialidades: ['oft', 'kine'], firma: 'K1', updated: 5 };
  const m = makeMedico(futuro);
  assert.deepEqual(m.especialidades, ['oft', 'kine']);
  assert.equal(m.firma, 'K1');
  assert.equal(m.rol, 'kinesiologo');
  assert.equal(makeOperativo({ nombre: 'Op', lugar: 'Hanga Roa' }).lugar, 'Hanga Roa');
  // Y sobreviven a guardarse y leerse en este equipo.
  const store = createStore(memoryStorage(), /** @type {any} */ ({}));
  store.saveMedicos([m]);
  assert.equal(store.loadMedicos()[0].firma, 'K1');
});

test('fichas de pacientes: campos nuevos se conservan, también al fusionar entre equipos', () => {
  const raw = {
    id: 'p_aaaaaaaaaa',
    v: 2,
    updated: 10,
    prevision: 'FONASA B',
    f: { paciente_nombre: 'Ana', paciente_correo: 'a@b.cl', fusionado_en: 'p_bbbbbbbbbb' },
    ft: { 'f.paciente_nombre': 10, 'f.paciente_correo': 10 },
  };
  const p = normalizePatient(raw);
  assert.equal(p.prevision, 'FONASA B');
  assert.equal(p.f.paciente_correo, 'a@b.cl');
  assert.equal(p.f.fusionado_en, 'p_bbbbbbbbbb');
  assert.equal(p.v, 2, 'no se degrada la versión de esquema');
  // Otro equipo (esta versión) edita el nombre: el campo nuevo sigue ahí.
  const local = {
    ...structuredClone(p),
    f: { ...p.f, paciente_nombre: 'Ana María' },
    ft: { ...p.ft, 'f.paciente_nombre': 20 },
    updated: 20,
  };
  const m = normalizePatient(syncMerge('paciente', local, p).data);
  assert.equal(m.f.paciente_nombre, 'Ana María');
  assert.equal(m.f.paciente_correo, 'a@b.cl');
  assert.equal(m.prevision, 'FONASA B');
});

test('atenciones: campos y datos nuevos se conservan al normalizar y fusionar', () => {
  const r = minimalRecord('a1', { paciente_nombre: 'Ana', campo_nuevo: 'x' }, { updated: 10 });
  r.extra_futuro = { k: 1 };
  const n = normalizeRecord(r);
  assert.equal(n.f.campo_nuevo, 'x');
  assert.deepEqual(n.extra_futuro, { k: 1 });
  const m = mergeRecords(n, normalizeRecord({ ...r, f: { ...r.f, od_pio: '18' }, updated: 20 }));
  assert.equal(m.f.campo_nuevo, 'x');
  assert.deepEqual(m.extra_futuro, { k: 1 });
});
