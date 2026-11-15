import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventRows, sessionRows, fmtDuration, EVENT_INFO } from '../src/core/accessLog.js';
import { CLIENT_EVENTS } from '../src/sync/accounts.js';

const names = { u1: 'Dra. Soto', u2: 'Ana Admisión' };
const userName = (uid) => names[uid] || '?';
const objectLabel = (e) => (e.obj ? `obj:${e.obj}` : '');

test('registro de accesos: cada evento que puede informar la app tiene su texto', () => {
  for (const ev of CLIENT_EVENTS) assert.ok(EVENT_INFO[ev], ev);
});

test('eventos: legibles, del más reciente al más antiguo, con filtros por grupo, persona y texto', () => {
  const ev = [
    { t: 1000, ev: 'sesion.inicio', u: 'u1' },
    { t: 3000, ev: 'atencion.ver', u: 'u2', obj: 'a1' },
    { t: 2000, ev: 'sync.escribir', u: 'u1', n: 3, esp: 'oftalmologia' },
    { t: 4000, ev: 'ficha.ver', u: 'u2', obj: 'p_x', off: true, at: Date.UTC(2026, 10, 15, 13) },
    { t: 500, ev: 'cuentas.activar', obj: 'u1' },
  ];
  const all = eventRows(ev, { userName, objectLabel });
  assert.deepEqual(
    all.map((r) => r.t),
    [4000, 3000, 2000, 1000, 500],
  );
  assert.equal(all[0].accion, 'Abrió la ficha');
  assert.match(all[0].origen, /^sin conexión \(hora del PC/);
  assert.equal(all[2].detalle, '3 elementos');
  assert.equal(all[4].persona, 'Contraseña del equipo');
  assert.deepEqual(
    eventRows(ev, { userName, objectLabel, group: 'lecturas' }).map((r) => r.accion),
    ['Abrió la ficha', 'Abrió la atención'],
  );
  assert.equal(eventRows(ev, { userName, objectLabel, uid: 'u1' }).length, 2);
  assert.equal(eventRows(ev, { userName, objectLabel, query: (t) => t.includes('obj:a1') }).length, 1);
});

test('sesiones: duración hasta el cierre, o hasta el último uso si quedó abierta o venció', () => {
  const now = 10 * 3600_000;
  const s = sessionRows(
    [
      { id: 's1', uid: 'u1', inicio: 0, ultimo: 30 * 60_000, exp: 12 * 3600_000, fin: 85 * 60_000, motivo: 'inactividad' },
      { id: 's2', uid: 'u2', inicio: 3600_000, ultimo: 3600_000 + 20 * 60_000, exp: 2 * 3600_000 },
      { id: 's3', uid: 'u2', inicio: 9 * 3600_000, ultimo: 9.5 * 3600_000, exp: 21 * 3600_000 },
    ],
    { userName, now },
  );
  assert.deepEqual(
    s.map((r) => [r.persona, r.duracionMin, r.estado]),
    [
      ['Ana Admisión', 30, 'abierta (último uso)'],
      ['Ana Admisión', 20, 'venció (último uso)'],
      ['Dra. Soto', 85, 'por inactividad'],
    ],
  );
  assert.equal(fmtDuration(85), '1 h 25 min');
  assert.equal(fmtDuration(120), '2 h');
  assert.equal(fmtDuration(8), '8 min');
});
