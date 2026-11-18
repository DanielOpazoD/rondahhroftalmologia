import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, unflatten } from '../src/core/fields.js';
import { changedPaths, stampChanges, ensureFt, mergeRecords, sameContent, ftOf } from '../src/core/merge.js';
import { normalizeRecord } from '../src/core/record.js';
import { minimalRecord } from './fixtures.js';
import { MAX_AHEAD_MS } from '../src/core/clock.js';

const base = () =>
  normalizeRecord({
    id: 'a1',
    created: 100,
    updated: 100,
    ft: {},
    cat: '',
    checks: { antecedente_hta: true },
    proc: { fo: { eye: 'AO' } },
    f: { paciente_nombre: 'Ana Tuki', paciente_rut: '12.345.678-5', fecha_atencion: '2026-11-14' },
  });

/** Simula una edición en un equipo: cambia el registro y sella los campos tocados. */
function edit(rec, t, fn) {
  const before = structuredClone(rec);
  const next = structuredClone(rec);
  fn(next);
  next.updated = t;
  return stampChanges(next, before, t);
}

test('flatten / unflatten ida y vuelta, sin vacíos', () => {
  const r = base();
  r.proc.t_aplan = { eye: 'OD', od: '14', oi: '' };
  r.checks.diagnostico_rdp = false;
  r.cat = 'OI';
  const m = flatten(r);
  assert.equal(m.get('proc.t_aplan.od'), '14');
  assert.ok(!m.has('proc.t_aplan.oi') && !m.has('checks.diagnostico_rdp'));
  const u = unflatten(m);
  assert.deepEqual(u.proc.t_aplan, { eye: 'OD', od: '14' });
  assert.equal(u.cat, 'OI');
  assert.deepEqual(unflatten(new Map([['proc.x.od', '12']])).proc, {}, 'sin ojo no hay procedimiento');
});

test('stampChanges sella solo los campos editados', () => {
  const r = base();
  const e = edit(r, 200, (x) => {
    x.f.od_pio = '18';
    delete x.checks.antecedente_hta;
  });
  assert.deepEqual(Object.keys(e.ft).sort(), ['checks.antecedente_hta', 'f.od_pio']);
  assert.deepEqual(changedPaths(r, e).sort(), ['checks.antecedente_hta', 'f.od_pio']);
});

test('dos equipos editan campos distintos: se conservan ambos', () => {
  const r = base();
  const pc1 = edit(r, 200, (x) => (x.f.od_pio = '18')); // enfermera anota PIO
  const pc2 = edit(r, 210, (x) => {
    x.checks.diagnostico_glaucoma = true; // médico anota diagnóstico
    x.proc.campimetria = { eye: 'AO' };
  });
  const m = mergeRecords(pc1, pc2);
  assert.equal(m.f.od_pio, '18');
  assert.equal(m.checks.diagnostico_glaucoma, true);
  assert.deepEqual(m.proc.campimetria, { eye: 'AO' });
  assert.equal(m.checks.antecedente_hta, true, 'lo que nadie tocó se mantiene');
  assert.equal(m.updated, 210);
  assert.ok(sameContent(m, mergeRecords(pc2, pc1)), 'conmutativa');
  assert.ok(sameContent(m, mergeRecords(m, pc1)) && sameContent(m, mergeRecords(m, m)), 'idempotente');
});

test('mismo campo editado en ambos: gana la edición más reciente', () => {
  const r = base();
  const pc1 = edit(r, 300, (x) => (x.f.od_pio = '18'));
  const pc2 = edit(r, 250, (x) => (x.f.od_pio = '20'));
  assert.equal(mergeRecords(pc1, pc2).f.od_pio, '18');
  assert.equal(mergeRecords(pc2, pc1).f.od_pio, '18');
});

test('PIO de un mismo procedimiento por ojo, editadas en equipos distintos', () => {
  const r = base();
  r.proc.t_aplan = { eye: 'AO' };
  const pc1 = edit(r, 200, (x) => (x.proc.t_aplan.od = '14'));
  const pc2 = edit(r, 205, (x) => (x.proc.t_aplan.oi = '16'));
  assert.deepEqual(mergeRecords(pc1, pc2).proc.t_aplan, { eye: 'AO', od: '14', oi: '16' });
});

test('borrar un campo también es una edición (y gana si es más reciente)', () => {
  const r = base();
  r.f.receta = 'Lágrimas';
  const pc1 = edit(r, 400, (x) => delete x.f.receta);
  const pc2 = edit(r, 300, (x) => (x.f.od_av = '20/40'));
  const m = mergeRecords(pc1, pc2);
  assert.ok(!('receta' in m.f));
  assert.equal(m.f.od_av, '20/40');
});

test('empate exacto de fechas: resultado determinista en ambos sentidos', () => {
  const r = base();
  const a = edit(r, 500, (x) => (x.f.plan = 'A'));
  const b = edit(r, 500, (x) => (x.f.plan = 'B'));
  assert.equal(mergeRecords(a, b).f.plan, mergeRecords(b, a).f.plan);
});

test('registros antiguos sin ft usan su fecha de actualización', () => {
  const old = minimalRecord('a1', { paciente_nombre: 'Viejo', od_pio: '10' }, { updated: 50 });
  delete old.ft;
  assert.equal(ftOf(old, 'f.od_pio'), 50);
  const newer = edit(ensureFt(structuredClone(old)), 80, (x) => (x.f.oi_pio = '12'));
  const m = mergeRecords(old, newer);
  assert.equal(m.f.od_pio, '10');
  assert.equal(m.f.oi_pio, '12');
});

test('combinar una atención nueva con una existente del mismo paciente', () => {
  const existing = edit(base(), 200, (x) => (x.f.od_pio = '18'));
  // atención nueva creada en otro PC sin saber de la existente: solo sus campos editados tienen fecha
  const nueva = normalizeRecord({ id: null, ft: {}, checks: {}, proc: {}, f: { fecha_atencion: '2026-11-14' } });
  const nuevaEd = edit(nueva, 300, (x) => {
    x.f.paciente_rut = '12.345.678-5';
    x.checks.diagnostico_catarata = true;
    x.cat = 'OD';
  });
  const m = mergeRecords(existing, { ...nuevaEd, id: existing.id });
  assert.equal(m.id, 'a1');
  assert.equal(m.f.paciente_nombre, 'Ana Tuki', 'no borra lo que la nueva no tenía');
  assert.equal(m.f.od_pio, '18');
  assert.equal(m.checks.diagnostico_catarata, true);
  assert.equal(m.cat, 'OD');
});

test('normalizeRecord conserva ft válido y descarta basura', () => {
  assert.deepEqual(normalizeRecord({ id: 'x', ft: { 'f.a': 5, 'f.b': 'no' } }).ft, { 'f.a': 5 });
  assert.equal(normalizeRecord({ id: 'x', ft: 'mal' }).ft, undefined);
});

test('claves maliciosas (__proto__, constructor) no contaminan prototipos', () => {
  const evil = JSON.parse(
    '{"id":"a1","updated":9,"ft":{},"f":{"__proto__":"x","ok":"1"},"checks":{"constructor":true},"proc":{"__proto__":{"eye":"OD","polluted":"yes"},"fo":{"eye":"AO"}}}',
  );
  const m = mergeRecords(base(), evil);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.eye, undefined);
  assert.deepEqual(Object.keys(m.proc).sort(), ['fo']);
  // también por rutas fabricadas en ft
  mergeRecords({ id: 'a', ft: { 'proc.__proto__.eye': 99 }, f: {}, checks: {}, proc: {} }, base());
  assert.equal(Object.prototype.eye, undefined);
  const n = normalizeRecord(evil);
  assert.ok(!Object.hasOwn(n.proc, '__proto__') && !Object.hasOwn(n.checks, 'constructor'));
});

test('vínculo con el paciente: el cambio fechado gana sin importar el orden de los ids', () => {
  for (const [viejo, nuevo] of [
    ['p_aaaaaaaaaa', 'p_bbbbbbbbbb'],
    ['p_bbbbbbbbbb', 'p_aaaaaaaaaa'],
  ]) {
    const orig = {
      id: 'x',
      updated: 10,
      pacienteId: viejo,
      f: { paciente_nombre: 'Rosa' },
      checks: {},
      proc: {},
      ft: { 'f.paciente_nombre': 10, pacienteId: 10 },
    };
    // Un equipo agrega el RUT y la atención pasa a otra ficha (como hace «guardar»).
    const cambiado = { ...structuredClone(orig), pacienteId: nuevo, updated: 20, f: { paciente_nombre: 'Rosa', paciente_rut: '1-9' } };
    cambiado.ft = { ...cambiado.ft, 'f.paciente_rut': 20, pacienteId: 20 };
    // Otro equipo edita otro campo al mismo tiempo.
    const otro = { ...structuredClone(orig), updated: 15, f: { paciente_nombre: 'Rosa', od_pio: '18' } };
    otro.ft = { ...otro.ft, 'f.od_pio': 15 };
    for (const m of [mergeRecords(cambiado, otro), mergeRecords(otro, cambiado)]) {
      assert.equal(m.pacienteId, nuevo);
      assert.equal(m.f.od_pio, '18');
    }
  }
});

test('fusión: un campo fechado muy en el futuro (reloj malo o dato manipulado) no gana para siempre', () => {
  const NOW = Date.UTC(2026, 10, 17, 12);
  const rogue = { id: 'a1', updated: 1, f: { plan: 'del futuro' }, ft: { 'f.plan': Date.UTC(2099, 0, 1) } };
  // Mientras el dato sea creíble (hasta 12 h adelante) se respeta; más allá cuenta como «ahora + 12 h».
  const soon = { id: 'a1', updated: 2, f: { plan: 'editado ahora' }, ft: { 'f.plan': NOW } };
  assert.equal(mergeRecords(soon, rogue, { maxT: NOW + MAX_AHEAD_MS }).f.plan, 'del futuro');
  // Una edición posterior a ese tope sí gana (antes perdía siempre contra 2099).
  const later = { id: 'a1', updated: 3, f: { plan: 'editado mañana' }, ft: { 'f.plan': NOW + MAX_AHEAD_MS + 1 } };
  const m = mergeRecords(later, rogue, { maxT: NOW + MAX_AHEAD_MS });
  assert.equal(m.f.plan, 'editado mañana');
  assert.ok(m.ft['f.plan'] <= NOW + MAX_AHEAD_MS + 1, 'la fecha guardada también queda acotada');
});
