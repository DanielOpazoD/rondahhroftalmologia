/**
 * Exportación seudonimizada ORL. Códigos, limpieza de textos y
 * generalización de fecha y edad vienen de core/pseudonym.js (comunes);
 * aquí solo se define la forma de los datos. Ver docs/ANONIMIZACION.md.
 */
import { SEXOS, APP } from '../../config/catalogs.js';
import { DIAGNOSTICOS, ANTECEDENTES, SOLICITADOS, ESPECIALIDAD } from './config.js';
import { normalizeText, rutKey, fmtDateTime } from '../../core/format.js';
import { patientKey } from '../../core/record.js';
import { pseudonym, scrubText, generalizeAge, generalizeDate, ANON_DEFAULTS, ANON_OPTIONS } from '../../core/pseudonym.js';
import { ageOf } from '../../core/estadistica.js';
import { STYLE } from '../../lib/xlsx.js';
import { proceduresDone } from './clinica.js';

const DATE_FIELD = { mes: 'mes', relativa: 'dia_relativo', exacta: 'fecha', omitir: null };

/** Quita claves vacías (undefined, '' u objeto vacío); deja las listas vacías: informan "ninguno". */
function compact(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '' || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete obj[k];
  }
  return obj;
}

/** Textos libres de la salida: [clave de salida, campo del registro]. */
const TEXTOS = [
  ['antecedente_cirugia_detalle', 'antecedente_cirugia_detalle'],
  ['antecedentes_otros', 'antecedentes_otros'],
  ['motivo_consulta', 'motivo_consulta'],
  ['otoscopia_od', 'otoscopia_od'],
  ['otoscopia_oi', 'otoscopia_oi'],
  ['rinoscopia', 'rinoscopia'],
  ['orofaringe', 'orofaringe'],
  ['examen_observaciones', 'examen_obs'],
  ['solicitados_otros', 'procedimientos_otros'],
  ['diagnosticos_otros', 'diagnosticos_otros'],
  ['ges', 'ges'],
  ['interconsulta', 'interconsulta'],
  ['receta', 'receta'],
  ['plan', 'plan'],
  ['seguimiento', 'seguimiento'],
  ['alta', 'alta'],
];

/**
 * Seudonimiza un conjunto de atenciones.
 * @param {object[]} records
 * @param {import('./config.js').ProcDef[]} procs
 * @param {{secret: string, fechas?: string, edad?: string, texto?: string}} options
 */
export function anonymizeRecords(records, procs, options) {
  const opt = { ...ANON_DEFAULTS, ...options };
  const firstDate =
    records
      .map((r) => r.f?.fecha_atencion)
      .filter(Boolean)
      .sort()[0] || null;
  const correspondencia = new Map();

  const registros = records.map((r) => {
    const f = r.f || {};
    const pk = patientKey(r);
    const codigo = pseudonym(opt.secret, pk.key, 'P');
    const medicoKey = rutKey(f.medico_rut) || normalizeText(f.medico_nombre);
    const names = [f.paciente_nombre, f.medico_nombre].filter(Boolean);
    const txt = (v) => (opt.texto === 'excluir' ? undefined : scrubText((v || '').trim(), { names }) || undefined);

    const entry = correspondencia.get(codigo) || {
      codigo_paciente: codigo,
      nombre: f.paciente_nombre || '',
      rut: f.paciente_rut || '',
      base_codigo: pk.basis,
      atenciones: 0,
    };
    entry.atenciones++;
    correspondencia.set(codigo, entry);

    const out = {
      codigo_paciente: codigo,
      codigo_atencion: pseudonym(opt.secret, 'atencion:' + r.id, 'A'),
      base_codigo: pk.basis,
      operativo: (f.operativo || '').trim() || undefined,
      edad: generalizeAge(ageOf(r), opt.edad),
      sexo: SEXOS.find((s) => s.key === f.paciente_sexo)?.label || '',
      antecedentes: ANTECEDENTES.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      audiometria_od_db: (f.audiometria_od || '').trim() || undefined,
      audiometria_oi_db: (f.audiometria_oi || '').trim() || undefined,
      procedimientos_realizados: proceduresDone(r, procs).map((p) => ({ procedimiento: p.nombre, oido: p.lado })),
      examenes_solicitados: SOLICITADOS.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      diagnosticos: DIAGNOSTICOS.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      ...Object.fromEntries(TEXTOS.map(([k, campo]) => [k, txt(f[campo])])),
      codigo_medico: medicoKey ? pseudonym(opt.secret, 'medico:' + medicoKey, 'M', 6) : undefined,
    };
    const dateField = DATE_FIELD[opt.fechas];
    if (dateField) out[dateField] = generalizeDate(f.fecha_atencion, opt.fechas, firstDate);
    return compact(out);
  });

  return {
    registros,
    correspondencia: [...correspondencia.values()],
    opciones: { fechas: opt.fechas, edad: opt.edad, texto: opt.texto },
    primeraFecha: firstDate,
  };
}

/** Diccionario de variables, incluido en el JSON y en el Excel. */
export const DICCIONARIO = [
  ['codigo_paciente', 'Código seudónimo estable del paciente (HMAC-SHA256 de RUT o nombre con clave del equipo).'],
  ['codigo_atencion', 'Código seudónimo de la atención.'],
  ['base_codigo', "Con qué se generó el código: 'rut' (más confiable) o 'nombre'."],
  ['mes / dia_relativo / fecha', 'Fecha de atención generalizada según la opción elegida.'],
  ['edad', 'Edad en años o rango de 5 años; 90+ agrupado.'],
  ['antecedentes', `Lista marcada de: ${ANTECEDENTES.map((d) => d.label).join(', ')}.`],
  ['audiometria_od_db / audiometria_oi_db', 'Promedio tonal puro por oído (dB HL), tal como se registró.'],
  ['procedimientos_realizados', 'Lista de {procedimiento, oido (OD/OI/AO)}.'],
  ['examenes_solicitados', `Lista marcada de: ${SOLICITADOS.map((d) => d.label).join(', ')}.`],
  ['diagnosticos', `Lista marcada de: ${DIAGNOSTICOS.map((d) => d.label).join(', ')}.`],
  [TEXTOS.map(([k]) => k).join(', '), 'Textos libres limpios de identificadores (se omiten con «Excluir textos libres»).'],
  ['codigo_medico', 'Código seudónimo del médico tratante.'],
  ['[NOMBRE] [RUT] [NÚMERO] [FECHA] [EMAIL]', 'Marcadores que reemplazan identificadores encontrados en textos libres.'],
];

/** Documento JSON listo para compartir con una herramienta de análisis. */
export function anonymizedJson(result, now = new Date()) {
  return {
    descripcion: `Atenciones de ${ESPECIALIDAD.nombre.toLowerCase()} seudonimizadas (rondas y operativos). Sin nombres, RUT ni teléfonos.`,
    origen: `${ESPECIALIDAD.nombre} — ${APP.establecimiento}`,
    version_app: APP.version,
    generado: now.toISOString(),
    opciones: result.opciones,
    n_atenciones: result.registros.length,
    n_pacientes: result.correspondencia.length,
    diccionario: Object.fromEntries(DICCIONARIO),
    atenciones: result.registros,
  };
}

/** Hojas Excel con los datos seudonimizados (una fila por atención + diccionario). */
export function anonymizedSheets(result, _procs, now = new Date()) {
  const regs = result.registros;
  const dateHeader = { mes: 'Mes', relativa: 'Día relativo', exacta: 'Fecha', omitir: null }[result.opciones.fechas];
  const dateKey = DATE_FIELD[result.opciones.fechas];
  const textos = result.opciones.texto === 'excluir' ? [] : TEXTOS.map(([k]) => k);
  const flag = (list, label) => (list.includes(label) ? 1 : 0);
  const header = [
    'Código paciente',
    'Código atención',
    'Operativo',
    ...(dateHeader ? [dateHeader] : []),
    'Edad',
    'Sexo',
    ...ANTECEDENTES.map((d) => 'Ant ' + d.label),
    'Audiometría OD (dB)',
    'Audiometría OI (dB)',
    'Procedimientos realizados',
    ...SOLICITADOS.map((d) => 'Sol ' + d.label),
    ...DIAGNOSTICOS.map((d) => 'Dx ' + d.label),
    ...textos,
    'Código médico',
  ];
  const rows = regs.map((r) => [
    r.codigo_paciente,
    r.codigo_atencion,
    r.operativo || '',
    ...(dateKey ? [r[dateKey] ?? ''] : []),
    r.edad ?? '',
    r.sexo || '',
    ...ANTECEDENTES.map((d) => flag(r.antecedentes, d.label)),
    r.audiometria_od_db || '',
    r.audiometria_oi_db || '',
    r.procedimientos_realizados.map((p) => `${p.procedimiento} ${p.oido}`).join(', '),
    ...SOLICITADOS.map((d) => flag(r.examenes_solicitados, d.label)),
    ...DIAGNOSTICOS.map((d) => flag(r.diagnosticos, d.label)),
    ...textos.map((k) => r[k] || ''),
    r.codigo_medico || '',
  ]);
  const info = [
    [{ v: `Datos seudonimizados — ${ESPECIALIDAD.nombre} — ${APP.establecimiento}`, s: STYLE.bold }],
    ['Generado', fmtDateTime(now)],
    ['Atenciones', regs.length],
    ['Pacientes (códigos distintos)', result.correspondencia.length],
    ['Fechas', ANON_OPTIONS.fechas.find((o) => o[0] === result.opciones.fechas)?.[1] || ''],
    ['Edad', ANON_OPTIONS.edad.find((o) => o[0] === result.opciones.edad)?.[1] || ''],
    ['Textos libres', ANON_OPTIONS.texto.find((o) => o[0] === result.opciones.texto)?.[1] || ''],
    [],
    [
      { v: 'Variable', s: STYLE.bold },
      { v: 'Descripción', s: STYLE.bold },
    ],
    ...DICCIONARIO,
  ];
  return [
    { name: 'Datos', header: true, rows: [header, ...rows] },
    { name: 'Info y diccionario', rows: info, widths: [40, 100] },
  ];
}
