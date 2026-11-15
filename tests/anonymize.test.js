import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32,
  pseudonym,
  createSecret,
  secretFingerprint,
  scrubText,
  generalizeAge,
  generalizeDate,
  correspondenciaSheets,
  findLeaks,
  nameTokens,
} from '../src/core/pseudonym.js';
import { anonymizeRecords, anonymizedJson, anonymizedSheets } from '../src/specialties/oftalmologia/seudonimizacion.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { fullRecord, minimalRecord, PROCS } from './fixtures.js';
import { readZipWithPython } from './helpers.js';

const SECRET = 'a'.repeat(64);

describe('códigos seudónimos', () => {
  test('base32 Crockford', () => {
    assert.equal(base32(new Uint8Array([0])), '00');
    assert.equal(base32(new Uint8Array([255, 255, 255, 255, 255])), 'ZZZZZZZZ');
    assert.ok(!/[ILOU]/.test(base32(new Uint8Array(Array.from({ length: 64 }, (_, i) => i * 4)))));
  });

  test('pseudonym: estable, depende de la clave y tiene formato fijo', () => {
    const a = pseudonym(SECRET, 'rut:11111111-1');
    assert.match(a, /^P-[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.equal(pseudonym(SECRET, 'rut:11111111-1'), a);
    assert.notEqual(pseudonym('b'.repeat(64), 'rut:11111111-1'), a);
    assert.notEqual(pseudonym(SECRET, 'rut:22222222-2'), a);
    assert.throws(() => pseudonym('', 'x'));
  });

  test('createSecret y huella', () => {
    const s = createSecret();
    assert.match(s, /^[0-9a-f]{64}$/);
    assert.notEqual(createSecret(), s);
    assert.match(secretFingerprint(s), /^[0-9A-Z]{6}$/);
  });
});

describe('limpieza de textos', () => {
  test('reemplaza RUT, teléfonos, correos, fechas y nombres', () => {
    const t = scrubText(
      'Pac. María José Tepano, RUT 11.111.111-1 / 11111111-1, fono +56 9 8765 4321, mail a.b@x.cl, cx el 03/05/2019. AV 20/40, PIO 14.',
      {
        names: ['María José Tepano Pakarati', 'Ana Pérez'],
      },
    );
    assert.ok(!/Mar[ií]a|Jos[eé]|Tepano|11\.111|8765|a\.b@/.test(t), t);
    for (const m of ['[NOMBRE]', '[RUT]', '[NÚMERO]', '[EMAIL]', '[FECHA]']) assert.ok(t.includes(m), `falta ${m}: ${t}`);
    assert.ok(t.includes('AV 20/40, PIO 14'), 'no toca datos clínicos');
  });

  test('nombres sin importar tildes ni mayúsculas, y solo palabras completas', () => {
    assert.equal(scrubText('control con JOSE y josé', { names: ['José'] }), 'control con [NOMBRE] y [NOMBRE]');
    assert.equal(scrubText('Rosácea leve', { names: ['Rosa'] }), 'Rosácea leve');
    assert.deepEqual(nameTokens('Ana de la Paz'), ['ana', 'paz']);
    assert.equal(scrubText('', {}), '');
  });
});

describe('generalización', () => {
  test('edad', () => {
    assert.equal(generalizeAge(67, 'rango5'), '65-69');
    assert.equal(generalizeAge(67, 'exacta'), 67);
    assert.equal(generalizeAge(93, 'exacta'), '90+');
    assert.equal(generalizeAge(null, 'rango5'), '');
  });
  test('fecha', () => {
    assert.equal(generalizeDate('2026-11-14', 'mes'), '2026-11');
    assert.equal(generalizeDate('2026-11-14', 'exacta'), '2026-11-14');
    assert.equal(generalizeDate('2026-11-16', 'relativa', '2026-11-14'), 2);
    assert.equal(generalizeDate('2026-11-14', 'omitir'), '');
  });
});

describe('anonymizeRecords', () => {
  const records = () => [
    fullRecord(),
    minimalRecord('b', {
      paciente_rut: '11111111-1',
      paciente_nombre: 'María J. Tepano',
      fecha_atencion: '2026-11-16',
      medico_nombre: 'Dra. Ana Pérez Soto',
      medico_rut: '22222222-2',
    }),
    minimalRecord('c', { paciente_nombre: 'Pedro Hotus', paciente_fono: '987650000', paciente_edad: '45' }),
  ];

  test('no deja nombres, RUT ni teléfonos en la salida', () => {
    const recs = records();
    const res = anonymizeRecords(recs, PROCS, { secret: SECRET });
    const out = JSON.stringify(anonymizedJson(res));
    for (const s of [
      'Tepano',
      'Pakarati',
      'María',
      'Hotus',
      'Pedro',
      '11.111.111',
      '11111111',
      '8765',
      '987650000',
      'Pérez',
      '22.222.222',
    ]) {
      assert.ok(!out.includes(s), `se filtró: ${s}`);
    }
    assert.deepEqual(findLeaks(out, recs), []);
  });

  test('mismo paciente => mismo código; tabla de correspondencia', () => {
    const res = anonymizeRecords(records(), PROCS, { secret: SECRET });
    const [a, b, c] = res.registros;
    assert.equal(a.codigo_paciente, b.codigo_paciente);
    assert.notEqual(a.codigo_paciente, c.codigo_paciente);
    assert.equal(a.codigo_medico, b.codigo_medico);
    assert.equal(res.correspondencia.length, 2);
    assert.equal(res.correspondencia.find((x) => x.codigo_paciente === a.codigo_paciente).atenciones, 2);
    assert.equal(c.base_codigo, 'nombre');
  });

  test('conserva datos clínicos útiles', () => {
    const [a] = anonymizeRecords(records(), PROCS, { secret: SECRET }).registros;
    assert.equal(a.edad, '65-69');
    assert.equal(a.sexo, 'Femenino');
    assert.equal(a.mes, '2026-11');
    assert.deepEqual(a.diagnosticos, ['RDNP', 'Catarata']);
    assert.equal(a.catarata_ojo, 'OD');
    assert.deepEqual(a.procedimientos_realizados[1], { procedimiento: 'T. Aplanática', ojo: 'AO', pio_od: '14', pio_oi: '16' });
    assert.equal(a.examen.od.pio, '14 Apl');
    assert.ok(a.motivo_consulta.includes('[NOMBRE]'));
    assert.ok(!('paciente_nombre' in a) && !('fecha' in a));
  });

  test('opciones: fecha relativa, edad exacta y excluir textos', () => {
    const res = anonymizeRecords(records(), PROCS, { secret: SECRET, fechas: 'relativa', edad: 'exacta', texto: 'excluir' });
    const [a, b] = res.registros;
    assert.equal(a.dia_relativo, 0);
    assert.equal(b.dia_relativo, 2);
    assert.equal(a.edad, 67);
    for (const k of ['motivo_consulta', 'plan', 'diagnosticos_otros', 'ges']) assert.ok(!(k in a), k);
    assert.ok(!('hallazgos' in (a.examen.od || {})));
    const omit = anonymizeRecords(records(), PROCS, { secret: SECRET, fechas: 'omitir' }).registros[0];
    assert.ok(!('mes' in omit) && !('fecha' in omit) && !('dia_relativo' in omit));
  });

  test('findLeaks detecta un nombre que se escapó', () => {
    const leaks = findLeaks('{"plan":"llamar a Pakarati al 98765 4321"}', [fullRecord()]);
    assert.deepEqual(leaks.map((l) => l.tipo).sort(), ['Nombre', 'Teléfono']);
    assert.ok(!leaks.some((l) => l.muestra.includes('Pakarati')), 'el aviso enmascara el valor');
  });

  test('Excel seudonimizado y tabla de correspondencia son .xlsx válidos', () => {
    const res = anonymizeRecords(records(), PROCS, { secret: SECRET });
    const anon = readZipWithPython(buildXlsx(anonymizedSheets(res, PROCS)));
    const anonText = Object.values(anon).join('');
    assert.ok(!anonText.includes('Tepano') && !anonText.includes('11.111.111'));
    assert.ok(anonText.includes(res.registros[0].codigo_paciente));
    const key = readZipWithPython(buildXlsx(correspondenciaSheets(res)));
    assert.ok(Object.values(key).join('').includes('Tepano'));
  });
});
