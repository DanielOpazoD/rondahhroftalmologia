import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageAt } from '../src/core/format.js';
import { applyBirthDate, validateRecord, blankRecord } from '../src/core/record.js';
import { medicoId, operativoId, makeMedico, makeOperativo, seedCatalogs, findMedico, upsert, byName } from '../src/core/catalog.js';
import { createStore, memoryStorage } from '../src/storage/store.js';
import { ESPECIALIDAD, STORAGE_KEYS } from '../src/config/catalogs.js';
import { minimalRecord } from './fixtures.js';

test('ageAt: años cumplidos', () => {
  assert.equal(ageAt('1959-11-14', '2026-11-14'), 67, 'cumpleaños el mismo día');
  assert.equal(ageAt('1959-11-15', '2026-11-14'), 66, 'un día antes del cumpleaños');
  assert.equal(ageAt('2000-02-29', '2026-02-28'), 25);
  assert.equal(ageAt('2026-11-15', '2026-11-14'), null, 'nacimiento posterior');
  assert.equal(ageAt('', '2026-11-14'), null);
});

test('applyBirthDate calcula la edad a la fecha de atención', () => {
  const r = minimalRecord('a', { paciente_fnac: '1959-11-15', fecha_atencion: '2026-11-14', paciente_edad: '99' });
  assert.equal(applyBirthDate(r), true);
  assert.equal(r.f.paciente_edad, '66');
  assert.equal(applyBirthDate(r), false, 'sin cambios la segunda vez');
  r.f.fecha_atencion = '2026-11-15';
  applyBirthDate(r);
  assert.equal(r.f.paciente_edad, '67');
  const sin = minimalRecord('b', { paciente_edad: '40' });
  assert.equal(applyBirthDate(sin), false, 'sin fecha de nacimiento no toca la edad');
  assert.equal(sin.f.paciente_edad, '40');
});

test('validación de fecha de nacimiento', () => {
  const now = new Date(2026, 10, 14);
  const v = validateRecord(minimalRecord('a', { paciente_nombre: 'X', paciente_fnac: '2026-12-01' }), now);
  assert.equal(v.fields.paciente_fnac.level, 'warn');
  assert.deepEqual(v.errors, []);
  assert.ok(!validateRecord(minimalRecord('a', { paciente_nombre: 'X', paciente_fnac: '1950-01-01' }), now).fields.paciente_fnac);
});

test('blankRecord marca la especialidad', () => {
  assert.equal(blankRecord().especialidad, ESPECIALIDAD.id);
  assert.ok(Object.values(STORAGE_KEYS).every((k) => k.startsWith(ESPECIALIDAD.prefijo)));
});

test('ids de catálogo deterministas (sin duplicados entre equipos)', () => {
  assert.equal(medicoId('Ana Pérez', '22.222.222-2'), medicoId('ANA PEREZ', '22222222-2'));
  assert.equal(medicoId('Ana Pérez', ''), medicoId('ana  pérez'));
  assert.notEqual(medicoId('Ana Pérez', '22.222.222-2'), medicoId('Ana Pérez', ''));
  assert.equal(operativoId('Operativo  Nov 2026'), operativoId('operativo nov 2026'));
  assert.match(operativoId('x'), /^o_[0-9a-z]{8}$/);
});

test('makeMedico / makeOperativo normalizan y validan', () => {
  const m = makeMedico({ nombre: '  Dra. Ana Pérez ', rut: '222222222' }, 10);
  assert.deepEqual(m, { id: medicoId('Dra. Ana Pérez', '22.222.222-2'), nombre: 'Dra. Ana Pérez', rut: '22.222.222-2', created: 10, updated: 10 });
  assert.equal(makeMedico({ nombre: ' ' }), null);
  const o = makeOperativo({ nombre: ' Ronda   Dic ' }, 5);
  assert.equal(o.nombre, 'Ronda Dic');
  assert.equal(makeOperativo({ nombre: 'x', id: 'bad id!' }).id, operativoId('x'), 'id inválido se recalcula');
});

test('seedCatalogs toma médicos y operativos de atenciones antiguas sin duplicar', () => {
  const records = [
    minimalRecord('a', { medico_nombre: 'Ana Pérez', medico_rut: '22.222.222-2', operativo: 'Op Nov' }),
    minimalRecord('b', { medico_nombre: 'ANA PÉREZ', medico_rut: '22222222-2', operativo: 'op nov' }),
    minimalRecord('c', { medico_nombre: 'Luis Rapu', operativo: 'Ronda Dic' }),
  ];
  const r = seedCatalogs({ records, recordado: { n: 'Luis Rapu', op: 'Ronda Dic' } }, 1);
  assert.deepEqual(r.medicos.map((m) => m.nombre), ['Ana Pérez', 'Luis Rapu']);
  assert.deepEqual(r.operativos.map((o) => o.nombre), ['Op Nov', 'Ronda Dic']);
  assert.equal(r.added, 4);
  assert.equal(seedCatalogs({ records, medicos: r.medicos, operativos: r.operativos }).added, 0, 'idempotente');
});

test('findMedico por RUT o por nombre; upsert y orden', () => {
  const meds = [makeMedico({ nombre: 'Ana Pérez', rut: '22.222.222-2' }), makeMedico({ nombre: 'Luis Rapu' })];
  assert.equal(findMedico(meds, 'otro nombre', '22222222-2').nombre, 'Ana Pérez');
  assert.equal(findMedico(meds, 'luis rapu', '').nombre, 'Luis Rapu');
  assert.equal(findMedico(meds, 'Nadie', ''), undefined);
  const edited = upsert(meds, { ...meds[1], nombre: 'Aaron Rapu', created: 999 });
  assert.equal(edited.length, 2);
  assert.equal(edited[1].created, meds[1].created, 'conserva la fecha de creación');
  assert.deepEqual(byName(edited).map((m) => m.nombre), ['Aaron Rapu', 'Ana Pérez']);
});

test('store guarda y lee catálogos, descartando entradas inválidas', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  store.saveMedicos([makeMedico({ nombre: 'Ana' }), { nombre: '' }]);
  store.saveOperativos([makeOperativo({ nombre: 'Op' })]);
  assert.equal(store.loadMedicos().length, 1);
  assert.equal(store.loadOperativos()[0].nombre, 'Op');
  mem.setItem(STORAGE_KEYS.medicos, '{roto');
  assert.deepEqual(store.loadMedicos(), []);
});
