import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personName, nameParts, refreshNames, hasNameParts } from '../src/core/names.js';
import { normalizeRecord, blankRecord, findDuplicate, patientIdentityKey } from '../src/core/record.js';
import { patientFromRecord, patientIdFor, resolvePatientId, normalizePatient, isAttended } from '../src/core/patient.js';
import { prepareSave, patientUpdateFromRecord } from '../src/app/attentions.js';
import { mergeRecords, stampChanges, syncFingerprint } from '../src/core/merge.js';
import { makeMedico } from '../src/core/catalog.js';
import { encryptProfile, decryptProfile } from '../src/sync/accountCrypto.js';
import { importEncKey } from '../src/sync/crypto.js';

const original = {
  id: 'a_prueba',
  v: 4,
  created: 10,
  updated: 10,
  f: { paciente_nombre: 'María José Tepano Pakarati', fecha_atencion: '2026-11-15' },
  checks: {},
  proc: {},
};
const split = { paciente_apellido_paterno: 'Tepano', paciente_apellido_materno: 'Pakarati', paciente_nombres: 'María José' };

test('nombres: migra sin adivinar, conserva el vínculo al organizar un nombre sin RUT', () => {
  const old = normalizeRecord(original);
  const id = old.pacienteId;
  const p = patientFromRecord(old, 10);
  assert.equal(old.f.paciente_nombre, original.f.paciente_nombre);
  assert.equal(hasNameParts(old.f, 'paciente_'), false);
  const draft = structuredClone(old);
  Object.assign(draft.f, split);
  refreshNames(draft.f);
  stampChanges(draft, old, 20);
  const saved = prepareSave({ rec: draft, stored: old, patients: [p], procs: [], now: 20 });
  assert.equal(saved.pacienteId, id);
  assert.equal(saved.f.paciente_nombre, 'Tepano Pakarati María José');
  assert.equal(resolvePatientId(saved.f, [p], id), id);
  const master = normalizePatient(patientUpdateFromRecord(saved, p, 20));
  assert.equal(master.id, p.id);
  assert.equal(master.f.paciente_nombres, 'María José');
  assert.equal(patientIdFor({ ...split }), patientIdFor({ paciente_nombre: 'Tepano Pakarati María José' }));
  assert.equal(isAttended({ f: split }), false);
  const another = { ...saved, id: 'another' };
  assert.equal(findDuplicate(another, [old]), old);
  assert.equal(patientIdentityKey(another), patientIdentityKey(old));
});

test('nombres: dos PC editan componentes diferentes y borran el materno sin que el nombre completo viejo lo reponga', () => {
  const base = normalizeRecord({ ...original, f: { ...original.f, ...split } });
  const change = (key, value, t) => {
    const r = structuredClone(base);
    r.f[key] = value;
    refreshNames(r.f);
    stampChanges(r, base, t);
    r.updated = t;
    return r;
  };
  const a = change('paciente_apellido_materno', '', 20),
    b = change('paciente_nombres', 'María Ana', 30);
  const merged = mergeRecords(a, b);
  assert.equal(merged.f.paciente_nombre, 'Tepano María Ana');
  assert.equal(merged.f.paciente_apellido_materno, undefined);
  assert.deepEqual(merged, mergeRecords(b, a));
  assert.deepEqual(mergeRecords(merged, base), merged);
  assert.equal(normalizeRecord(merged).f.paciente_nombre, 'Tepano María Ana');
  assert.equal(personName({ nombre: 'Texto anterior' }), 'Texto anterior');
  assert.deepEqual(nameParts({ nombre: 'Texto anterior' }), {});
  assert.equal(personName({ nombres: '', nombre: 'Anterior' }), '');
});

test('nombres: perfiles, médico recordado y perfil cifrado conservan componentes y orden', async () => {
  const parts = { apellido_paterno: 'De la Fuente', apellido_materno: 'Tuki', nombres: 'Ana María' };
  const old = makeMedico({ nombre: 'Ana María De la Fuente Tuki', rut: '11.111.111-1' }, 10);
  const m = makeMedico({ ...old, ...parts }, 20);
  assert.equal(m.id, old.id);
  assert.equal(m.nombre, 'De la Fuente Tuki Ana María');
  assert.notEqual(syncFingerprint('medico', old), syncFingerprint('medico', m));
  const rec = blankRecord({ n: m.nombre, r: m.rut, ...parts });
  assert.equal(rec.f.medico_nombres, 'Ana María');
  assert.equal(isAttended(rec), false);
  const key = await importEncKey(Buffer.alloc(32, 7).toString('base64'));
  const profile = { nombre: m.nombre, rut: m.rut, rol: 'medico', ...parts };
  assert.deepEqual(await decryptProfile(key, 'u_prueba', await encryptProfile(key, 'u_prueba', profile)), profile);
  assert.deepEqual(await decryptProfile(key, 'u_legacy', await encryptProfile(key, 'u_legacy', { nombre: 'Nombre anterior', rut: '' })), {
    nombre: 'Nombre anterior',
    rut: '',
  });
});
