/**
 * Exportación seudonimizada de atenciones, para análisis externo (por ejemplo, con IA).
 *
 * Qué hace:
 *  1. Reemplaza al paciente por un CÓDIGO estable `P-XXXXXXXX`, calculado con
 *     HMAC-SHA256(clave secreta del equipo, RUT o nombre). El mismo paciente
 *     recibe siempre el mismo código, pero el código no permite volver al RUT
 *     sin la clave ni la tabla de correspondencia.
 *  2. Elimina nombre, RUT, teléfono y datos del médico (que pasa a `M-XXXXXX`).
 *  3. Generaliza fecha (mes / día relativo / omitir) y edad (rango de 5 años).
 *  4. Limpia los textos libres: RUT, teléfonos, correos, fechas y los nombres
 *     del paciente y del médico se reemplazan por marcadores ([RUT], [NOMBRE]…).
 *  5. Revisa la salida buscando identificadores que se hayan escapado.
 *
 * Importante: esto es SEUDONIMIZACIÓN, no anonimización absoluta. Con la tabla
 * de correspondencia se puede reidentificar; guardarla separada de los datos.
 * Ver docs/ANONIMIZACION.md.
 */
import { SEXOS, APP } from '../../config/catalogs.js';
import { DIAGNOSTICOS, ANTECEDENTES, SOLICITADOS } from './config.js';
import { normalizeText, rutKey, fmtDateTime } from '../../core/format.js';
import { patientKey } from '../../core/record.js';
import { pseudonym, scrubText, generalizeAge, generalizeDate, ANON_DEFAULTS, ANON_OPTIONS } from '../../core/pseudonym.js';
import { proceduresDone, pioFor } from './clinica.js';
import { ageOf } from './estadistica.js';
import { STYLE } from '../../lib/xlsx.js';

const DATE_FIELD = { mes: 'mes', relativa: 'dia_relativo', exacta: 'fecha', omitir: null };

/* ------------------------------------------------------- transformación */

/**
 * Seudonimiza un conjunto de atenciones.
 * @param {object[]} records
 * @param {import('./config.js').ProcDef[]} procs
 * @param {{secret: string, fechas?: string, edad?: string, texto?: string}} options
 * @returns {{registros: object[], correspondencia: object[], opciones: object, primeraFecha: string|null}}
 */
export function anonymizeRecords(records, procs, options) {
  const opt = { ...ANON_DEFAULTS, ...options };
  const { secret } = opt;
  const dates = records
    .map((r) => r.f?.fecha_atencion)
    .filter(Boolean)
    .sort();
  const firstDate = dates[0] || null;
  const correspondencia = new Map();

  const registros = records.map((r) => {
    const f = r.f || {};
    const pk = patientKey(r);
    const codigo = pseudonym(secret, pk.key, 'P');
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

    const eye = (e) =>
      compact({
        av: (f[`${e}_av`] || '').trim() || undefined,
        pio: pioFor(r, e, procs) || undefined,
        otro_examen: (f[`${e}_otro_examen`] || '').trim() || undefined,
        otro_resultado: txt(f[`${e}_otro_resultado`]),
        hallazgos: txt(f[`${e}_hallazgos`]),
      });

    const out = {
      codigo_paciente: codigo,
      codigo_atencion: pseudonym(secret, 'atencion:' + r.id, 'A'),
      base_codigo: pk.basis,
      operativo: (f.operativo || '').trim() || undefined,
      edad: generalizeAge(ageOf(r), opt.edad),
      sexo: SEXOS.find((s) => s.key === f.paciente_sexo)?.label || '',
      antecedentes: ANTECEDENTES.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      antecedente_cirugia_detalle: txt(f.antecedente_cirugia_detalle),
      antecedentes_otros: txt(f.antecedentes_otros),
      motivo_consulta: txt(f.motivo_consulta),
      examen: compact({ od: eye('od'), oi: eye('oi'), observaciones: txt(f.examen_obs) }),
      procedimientos_realizados: proceduresDone(r, procs).map((p) =>
        compact({ procedimiento: p.nombre, ojo: p.ojo, pio_od: p.pioOd || undefined, pio_oi: p.pioOi || undefined }),
      ),
      procedimientos_solicitados: SOLICITADOS.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      test_schirmer_detalle: (f.test_schirmer_detalle || '').trim() || undefined,
      procedimientos_solicitados_otros: txt(f.procedimientos_otros),
      diagnosticos: DIAGNOSTICOS.filter((d) => r.checks?.[d.key]).map((d) => d.label),
      catarata_ojo: r.checks?.diagnostico_catarata ? r.cat || undefined : undefined,
      diagnosticos_otros: txt(f.diagnosticos_otros),
      ges: txt(f.ges),
      interconsulta: txt(f.interconsulta),
      receta: txt(f.receta),
      otras_acciones: txt(f.diagnosticos_acciones_otros),
      plan: txt(f.plan),
      seguimiento: txt(f.seguimiento),
      alta: txt(f.alta),
      codigo_medico: medicoKey ? pseudonym(secret, 'medico:' + medicoKey, 'M', 6) : undefined,
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

/** Quita claves con undefined / '' / objetos vacíos (deja arrays vacíos: informan "ninguno"). */
function compact(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '' || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete obj[k];
  }
  return obj;
}

/* --------------------------------------------------- verificación de fugas */

/** Diccionario de variables, incluido en el JSON y en el Excel. */
export const DICCIONARIO = [
  ['codigo_paciente', 'Código seudónimo estable del paciente (HMAC-SHA256 de RUT o nombre con clave del equipo).'],
  ['codigo_atencion', 'Código seudónimo de la atención.'],
  ['base_codigo', "Con qué se generó el código: 'rut' (más confiable) o 'nombre'."],
  ['operativo', 'Nombre del operativo o ronda.'],
  ['mes / dia_relativo / fecha', 'Fecha de atención generalizada según la opción elegida.'],
  ['edad', 'Edad en años o rango de 5 años; 90+ agrupado.'],
  ['sexo', 'Femenino / Masculino / Otro o no informa.'],
  ['antecedentes', `Lista marcada de: ${ANTECEDENTES.map((d) => d.label).join(', ')}.`],
  ['motivo_consulta', 'Texto libre limpio de identificadores.'],
  ['examen.od / examen.oi', 'Por ojo: av (agudeza visual), pio (mmHg; "Apl"/"Neu" = tonómetro), otro_examen, otro_resultado, hallazgos.'],
  ['procedimientos_realizados', 'Lista de {procedimiento, ojo (OD/OI/AO), pio_od, pio_oi}.'],
  ['procedimientos_solicitados', `Lista marcada de: ${SOLICITADOS.map((d) => d.label).join(', ')}.`],
  ['diagnosticos', `Lista marcada de: ${DIAGNOSTICOS.map((d) => d.label).join(', ')}.`],
  ['catarata_ojo', 'Lateralidad de la catarata (OD/OI/AO).'],
  ['ges, interconsulta, receta, otras_acciones', 'Gestiones registradas (texto limpio).'],
  ['plan, seguimiento, alta', 'Plan e indicaciones (texto limpio).'],
  ['codigo_medico', 'Código seudónimo del médico tratante.'],
  ['[NOMBRE] [RUT] [NÚMERO] [FECHA] [EMAIL]', 'Marcadores que reemplazan identificadores encontrados en textos libres.'],
];

/** Documento JSON listo para compartir con una herramienta de análisis. */
export function anonymizedJson(result, now = new Date()) {
  return {
    descripcion:
      'Atenciones oftalmológicas seudonimizadas (rondas y operativos). Sin nombres, RUT ni teléfonos. ' +
      'Cada paciente se identifica por codigo_paciente; varias atenciones del mismo paciente comparten el código.',
    origen: `${APP.nombre} — ${APP.establecimiento}`,
    version_app: APP.version,
    generado: now.toISOString(),
    opciones: result.opciones,
    n_atenciones: result.registros.length,
    n_pacientes: result.correspondencia.length,
    diccionario: Object.fromEntries(DICCIONARIO),
    atenciones: result.registros,
  };
}

/** Hojas Excel con los datos seudonimizados (formato ancho + prestaciones + diccionario). */
export function anonymizedSheets(result, procs, now = new Date()) {
  const regs = result.registros;
  const dateHeader = { mes: 'Mes', relativa: 'Día relativo', exacta: 'Fecha', omitir: null }[result.opciones.fechas];
  const dateKey = DATE_FIELD[result.opciones.fechas];
  const procNames = [
    ...new Set([...procs.map((p) => p.n), ...regs.flatMap((r) => r.procedimientos_realizados.map((p) => p.procedimiento))]),
  ];
  const withText = result.opciones.texto !== 'excluir';

  const header = [
    'Código paciente',
    'Código atención',
    'Operativo',
    ...(dateHeader ? [dateHeader] : []),
    'Edad',
    'Sexo',
    ...ANTECEDENTES.map((d) => 'Ant ' + d.label),
    ...(withText ? ['Motivo de consulta'] : []),
    'AV OD',
    'PIO OD',
    'AV OI',
    'PIO OI',
    ...(withText ? ['Hallazgos OD', 'Hallazgos OI'] : []),
    ...procNames,
    'N° procedimientos',
    ...SOLICITADOS.map((d) => 'Sol ' + d.label),
    ...DIAGNOSTICOS.map((d) => 'Dx ' + d.label),
    'Catarata ojo',
    ...(withText ? ['Otros diagnósticos', 'GES', 'IC', 'Receta', 'Plan', 'Seguimiento', 'Alta'] : []),
    'Código médico',
  ];
  const flag = (list, label) => (list.includes(label) ? 1 : 0);
  const rows = regs.map((r) => [
    r.codigo_paciente,
    r.codigo_atencion,
    r.operativo || '',
    ...(dateKey ? [r[dateKey] ?? ''] : []),
    r.edad ?? '',
    r.sexo || '',
    ...ANTECEDENTES.map((d) => flag(r.antecedentes, d.label)),
    ...(withText ? [r.motivo_consulta || ''] : []),
    r.examen?.od?.av || '',
    r.examen?.od?.pio || '',
    r.examen?.oi?.av || '',
    r.examen?.oi?.pio || '',
    ...(withText ? [r.examen?.od?.hallazgos || '', r.examen?.oi?.hallazgos || ''] : []),
    ...procNames.map((n) => r.procedimientos_realizados.find((p) => p.procedimiento === n)?.ojo || ''),
    r.procedimientos_realizados.length,
    ...SOLICITADOS.map((d) => flag(r.procedimientos_solicitados, d.label)),
    ...DIAGNOSTICOS.map((d) => flag(r.diagnosticos, d.label)),
    r.catarata_ojo || '',
    ...(withText
      ? [r.diagnosticos_otros || '', r.ges || '', r.interconsulta || '', r.receta || '', r.plan || '', r.seguimiento || '', r.alta || '']
      : []),
    r.codigo_medico || '',
  ]);

  const prest = [
    ['Código paciente', 'Código atención', ...(dateHeader ? [dateHeader] : []), 'Edad', 'Sexo', 'Procedimiento', 'Ojo', 'PIO OD', 'PIO OI'],
  ];
  for (const r of regs) {
    for (const p of r.procedimientos_realizados) {
      prest.push([
        r.codigo_paciente,
        r.codigo_atencion,
        ...(dateKey ? [r[dateKey] ?? ''] : []),
        r.edad ?? '',
        r.sexo || '',
        p.procedimiento,
        p.ojo,
        p.pio_od || '',
        p.pio_oi || '',
      ]);
    }
  }

  const info = [
    [{ v: 'Datos seudonimizados — ' + APP.establecimiento, s: STYLE.bold }],
    ['Generado', fmtDateTime(now)],
    ['Atenciones', regs.length],
    ['Pacientes (códigos distintos)', result.correspondencia.length],
    ['Fechas', ANON_OPTIONS.fechas.find((o) => o[0] === result.opciones.fechas)?.[1] || ''],
    ['Edad', ANON_OPTIONS.edad.find((o) => o[0] === result.opciones.edad)?.[1] || ''],
    ['Textos libres', ANON_OPTIONS.texto.find((o) => o[0] === result.opciones.texto)?.[1] || ''],
    [],
    [{ v: 'Advertencia', s: STYLE.bold }],
    ['Los textos libres se limpian automáticamente, pero conviene revisarlos antes de compartir.'],
    ['Sin la tabla de correspondencia (archivo aparte, confidencial) los códigos no permiten identificar pacientes.'],
    [],
    [
      { v: 'Variable', s: STYLE.bold },
      { v: 'Descripción', s: STYLE.bold },
    ],
    ...DICCIONARIO,
  ];

  return [
    { name: 'Datos', header: true, rows: [header, ...rows] },
    { name: 'Prestaciones', header: true, rows: prest },
    { name: 'Info y diccionario', rows: info, widths: [40, 100] },
  ];
}
