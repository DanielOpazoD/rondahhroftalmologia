/**
 * Datos de EJEMPLO para el modo práctica: perfiles, un operativo, pacientes
 * ficticios con atenciones anteriores (historial) y la lista del día con
 * pacientes por atender. Todo inventado; vive en un almacenamiento separado
 * que nunca se sincroniza.
 */
import { blankRecord, normalizeRecord, applyBirthDate } from './record.js';
import { patientIdFor } from './patient.js';
import { rutCheckDigit, formatRut } from './format.js';
import { makeMedico, makeOperativo } from './catalog.js';

/** Pacientes ficticios: [nombre, cuerpo del RUT, fecha de nacimiento, sexo]. */
const PACIENTES = [
  ['Ana Ejemplo Pakarati', '1111111', '1952-04-12', 'F'],
  ['Juan Prueba Tuki', '2222222', '1948-09-03', 'M'],
  ['María Demo Hotus', '3333333', '1961-01-27', 'F'],
  ['Pedro Ensayo Rapu', '4444444', '1970-06-15', 'M'],
  ['Rosa Práctica Atán', '5555555', '1958-11-30', 'F'],
  ['Luis Simulado Teao', '6666666', '1966-02-08', 'M'],
];

/** @param {string} body */
const rut = (body) => formatRut(body + rutCheckDigit(body));
/** @type {(iso: string, days: number) => string} */
const shift = (iso, days) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Los datos de ejemplo son fijos y válidos: si makeMedico/makeOperativo los
 * rechazara (null), es un error del código, no de los datos.
 * @template T
 * @param {T | null} v
 * @param {string} que
 * @returns {T}
 */
function valido(v, que) {
  if (v === null) throw new Error(`Dato de ejemplo inválido: ${que}`);
  return v;
}

/**
 * @param {{today: string, now: number, casos: import('../domain').CasoEjemplo[]}} o
 *   `casos`: parte clínica de ejemplo que aporta la especialidad.
 */
export function buildPracticeData({ today, now, casos }) {
  const operativo = valido(makeOperativo({ nombre: 'Operativo de práctica' }, now), 'operativo');
  const medicos = [
    makeMedico({ nombre: 'Dra. Ejemplo', rut: rut('7777777'), rol: 'medico' }, now),
    makeMedico({ nombre: 'Enf. Ejemplo', rol: 'enfermeria' }, now),
    makeMedico({ nombre: 'Admisión Ejemplo', rol: 'admision' }, now),
  ].map((m) => valido(m, 'perfil'));
  let seq = 0;
  /** @type {(p: string[], fecha: string, caso: import('../domain').CasoEjemplo | null) => import('../domain').Atencion} */
  const record = (p, fecha, caso) => {
    const [nombre, body, fnac, sexo] = p;
    const r = blankRecord({ op: operativo.nombre });
    Object.assign(r.f, {
      fecha_atencion: fecha,
      paciente_nombre: nombre,
      paciente_rut: rut(body),
      paciente_fnac: fnac,
      paciente_sexo: sexo,
    });
    const t = now - 1000 + seq;
    Object.assign(r, { id: `demo${(seq++).toString(36).padStart(3, '0')}`, created: t, updated: t, pacienteId: patientIdFor(r.f) });
    if (caso) {
      Object.assign(r.f, caso.f, { medico_nombre: medicos[0].nombre, medico_rut: medicos[0].rut });
      Object.assign(r.checks, caso.checks);
      r.proc = structuredClone(caso.proc);
      if (caso.cat) r.cat = caso.cat;
    }
    applyBirthDate(r);
    return normalizeRecord(r);
  };
  /** @param {number} i */
  const c = (i) => casos[i % Math.max(casos.length, 1)];
  const records = [
    // Historial: atenciones de operativos anteriores.
    record(PACIENTES[0], shift(today, -180), c(0)),
    record(PACIENTES[1], shift(today, -180), c(1)),
    record(PACIENTES[2], shift(today, -90), c(2)),
    // Hoy: una ya atendida y el resto por atender.
    record(PACIENTES[0], today, c(0)),
    ...PACIENTES.slice(1).map((p) => record(p, today, null)),
  ];
  return { medicos, operativos: [operativo], records };
}
