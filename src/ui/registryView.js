/**
 * Pestaña Pacientes: registro de pacientes (la unidad) y, por paciente, su
 * historial de atenciones de esta especialidad a lo largo del tiempo.
 */
import { SEXOS } from '../config/catalogs.js';
import { fmtDate, normalizeText, cleanRut, ageAt, isIsoDate, todayIso, isValidRut, compareCode, compareEs } from '../core/format.js';
import { isAttended, patientLabel, isCanonicalPatient, findDuplicatePairs, isDeletedPatient, patientsById } from '../core/patient.js';
import { diagnosesList, proceduresDone } from '../specialties/activa/index.js';
import { $, dataOf } from './dom.js';
import { html, setHtml, join } from './html.js';
import { icon } from './icons.js';

/** @typedef {import('./context.js').AppContext} AppContext */
/** @typedef {import('../domain').AtencionGuardada} AtencionGuardada */
/** @typedef {import('../domain').Paciente} Paciente */
/** Atenciones de cada paciente (por id de ficha), de la más reciente a la más antigua. @typedef {Map<string, AtencionGuardada[]>} PorPaciente */

/**
 * Elemento más cercano al destino del evento que cumple `sel` (o null).
 * @param {Event} e
 * @param {string} sel
 */
const closestTo = (e, sel) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(sel));

/** @param {AppContext} ctx */
export function initRegistryView(ctx) {
  ctx.openPatientId = null;
  $('#regSearch').addEventListener('input', () => renderRegistry(ctx));
  $('#regOp').addEventListener('change', () => renderRegistry(ctx));
  $('#regList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-p]');
    if (b) showPatient(ctx, dataOf(b, 'p'));
  });
  $('#patBack').addEventListener('click', () => showPatient(ctx, null));
  $('#dupList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'merge') ctx.mergePatients(dataOf(b, 'keep'), dataOf(b, 'drop'));
    if (b.dataset.a === 'distinct') ctx.notDuplicates(dataOf(b, 'keep'), dataOf(b, 'drop'));
    if (b.dataset.a === 'view') showPatient(ctx, dataOf(b, 'p'));
  });
  $('#orphList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-a]');
    if (b?.dataset.a === 'delp') void ctx.deletePatient(dataOf(b, 'p'));
  });
  $('#patNew').addEventListener('click', () => ctx.openPatientId && ctx.newAttentionFor(ctx.openPatientId));
  $('#patEdit').addEventListener('click', () => ctx.openPatientId && ctx.editPatient(ctx.openPatientId));
  $('#patAttentions').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLButtonElement | null} */ (closestTo(e, 'button[data-a]'));
    if (!b) return;
    const rec = ctx.records.find((r) => r.id === b.dataset.id);
    if (!rec) return;
    /** @type {Record<string, () => unknown>} */
    const actions = {
      open: () => ctx.openRecord(rec.id),
      pdf: () => ctx.downloadPdf(rec, b),
      copy: () => ctx.copyNote(rec),
      del: () => ctx.deleteRecord(rec.id),
    };
    actions[dataOf(b, 'a')]?.();
  });
}

/**
 * Coincide por nombre (sin tildes) o RUT (sin puntos ni guion).
 * @param {{f?: Record<string, string>}} p ficha (o atención)
 * @param {string} q
 */
function matchesQuery(p, q) {
  if (!q) return true;
  const nq = normalizeText(q);
  const rq = cleanRut(q);
  return normalizeText(p.f?.paciente_nombre).includes(nq) || (rq.length >= 3 && cleanRut(p.f?.paciente_rut).includes(rq));
}

/**
 * Atenciones agrupadas por paciente (una pasada).
 * @param {AtencionGuardada[]} records
 * @returns {PorPaciente}
 */
function byPatient(records) {
  /** @type {PorPaciente} */
  const map = new Map();
  for (const r of records) {
    if (!r.pacienteId) continue;
    const list = map.get(r.pacienteId);
    if (list) list.push(r);
    else map.set(r.pacienteId, [r]);
  }
  for (const list of map.values()) list.sort((a, b) => compareCode(b.f.fecha_atencion || '', a.f.fecha_atencion || ''));
  return map;
}

/**
 * Edad de hoy si hay fecha de nacimiento; si no, `fallback`.
 * @param {Paciente} p
 * @param {string | undefined} fallback
 */
const ageNow = (p, fallback) => (isIsoDate(p.f.paciente_fnac) ? ageAt(p.f.paciente_fnac, todayIso()) : fallback);
/** @param {string | undefined} k */
const sexLabel = (k) => SEXOS.find((s) => s.key === k)?.label || '';

/**
 * @param {AppContext} ctx
 * @param {string | null} id ficha a mostrar; null: la lista
 */
function showPatient(ctx, id) {
  ctx.openPatientId = id;
  if (id) ctx.accounts?.event('ficha.ver', id);
  $('#patListView').hidden = Boolean(id);
  $('#patDetailView').hidden = !id;
  renderRegistry(ctx);
  scrollTo(0, 0);
}

/** @param {AppContext} ctx */
export function renderRegistry(ctx) {
  const future = ctx.store.loadFutureRecords().length;
  $('#futureBanner').hidden = !future;
  $('#futureBanner').textContent = future
    ? `Hay ${future} atención(es) guardadas con una versión más nueva de la app. Recarga la página para verlas y editarlas.`
    : '';
  const groups = byPatient(ctx.records);
  if (ctx.openPatientId) return renderPatient(ctx, ctx.openPatientId, groups.get(ctx.openPatientId) || []);

  const sel = $('#regOp');
  const ops = ctx.operativos.map((o) => o.nombre);
  const cur = sel.value;
  setHtml(sel, html`<option value="">Todos los operativos</option>${ops.map((o) => html`<option value="${o}">${o}</option>`)}`);
  sel.value = ops.includes(cur) ? cur : '';

  const all = ctx.store.loadPatients();
  const byId = patientsById(all);
  renderDuplicates(ctx, byId, groups);
  renderOrphans(ctx, all, byId, groups);
  const q = $('#regSearch').value.trim();
  const op = sel.value;
  const patients = all
    // Las fichas unidas a otra no se muestran (sus atenciones ya están en la vigente).
    .filter((p) => isCanonicalPatient(byId, p) && !isDeletedPatient(p))
    .map((p) => ({ p, recs: groups.get(p.id) || [] }))
    .filter(({ p, recs }) => recs.length && matchesQuery(p, q) && (!op || recs.some((r) => r.f.operativo === op)))
    .sort(
      (a, b) =>
        compareCode(b.recs[0].f.fecha_atencion || '', a.recs[0].f.fecha_atencion || '') || compareEs(patientLabel(a.p), patientLabel(b.p)),
    );
  $('#regCount').textContent = patients.length;
  if (!patients.length) {
    const empty = ctx.records.length
      ? 'Sin resultados para esta búsqueda.'
      : html`Aún no hay pacientes.<br>Ingrésalos en la pestaña Ingreso o desde una atención.`;
    setHtml($('#regList'), html`<div class="empty">${empty}</div>`);
    return;
  }
  const rows = patients.slice(0, 500).map(({ p, recs }) => {
    const last = recs[0];
    const age = ageNow(p, last.f.paciente_edad);
    const meta = [
      p.f.paciente_rut,
      age !== '' && age != null ? `${age} a` : '',
      p.f.paciente_sexo,
      `última: ${fmtDate(last.f.fecha_atencion)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const dx = diagnosesList(last, { withOthers: false }).slice(0, 2);
    const count = `${recs.length} ${recs.length === 1 ? 'atención' : 'atenciones'}`;
    const pending = recs.some((r) => !isAttended(r));
    return html`<div class="prow"><button type="button" class="pmain" data-p="${p.id}" title="Ver paciente">
        <span class="pname">${patientLabel(p)}</span>
        <span class="pmeta">${meta}</span>
        <span class="ptags">${pending ? html`<span class="state pend">Por atender</span>` : ''}${dx.map((d) => html`<span class="tag">${d}</span>`)}<span class="tag soft">${count}</span></span>
      </button></div>`;
  });
  const more =
    patients.length > 500 ? html`<p class="hint">Se muestran los 500 más recientes: usa la búsqueda para encontrar otros.</p>` : '';
  setHtml($('#regList'), html`<section class="pgroup">${rows}</section>${more}`);
}

/**
 * Marca de validez del RUT junto al dato ('' si no hay RUT).
 * @param {string} rut
 */
function rutMark(rut) {
  if (!rut) return '';
  return isValidRut(rut)
    ? html` <span class="rutmark inline ok" title="RUT válido">✓</span>`
    : html` <span class="rutmark inline bad" title="RUT inválido">✗</span>`;
}

/**
 * Datos de la ficha que se conocen (RUT, nacimiento, edad, sexo, fono).
 * @param {Paciente} p
 * @param {ReturnType<typeof ageNow>} age
 */
function patientMeta(p, age) {
  const f = p.f;
  return [
    f.paciente_rut && html`RUT ${f.paciente_rut}${rutMark(f.paciente_rut)}`,
    f.paciente_fnac && html`Nac. ${fmtDate(f.paciente_fnac)}`,
    age !== '' && age != null && html`${String(age)} años`,
    sexLabel(f.paciente_sexo) && html`${sexLabel(f.paciente_sexo)}`,
    f.paciente_fono && html`Fono ${f.paciente_fono}`,
  ].filter(Boolean);
}

/**
 * Resumen de las atenciones de la ficha («3 atenciones de … · desde …»); '' si no tiene.
 * @param {AtencionGuardada[]} recs de la más reciente a la más antigua
 * @param {string} especialidad nombre de la especialidad activa
 */
function patientSummary(recs, especialidad) {
  if (!recs.length) return '';
  const first = recs[recs.length - 1].f.fecha_atencion;
  const since = first ? ` · desde ${fmtDate(first)}` : '';
  return `${recs.length} ${recs.length === 1 ? 'atención' : 'atenciones'} de ${especialidad}${since}`;
}

/**
 * Ficha abierta y sus atenciones.
 * @param {AppContext} ctx
 * @param {string} id ficha abierta
 * @param {AtencionGuardada[]} recs
 */
function renderPatient(ctx, id, recs) {
  const p = ctx.store.getPatient(id);
  if (!p) return showPatient(ctx, null);
  const meta = patientMeta(p, ageNow(p, recs[0]?.f.paciente_edad));
  const summary = patientSummary(recs, ctx.especialidadNombre);
  setHtml(
    $('#patCardInfo'),
    html`<h2>${patientLabel(p)}</h2><div class="patmeta">${join(meta, ' · ')}</div>${summary ? html`<div class="patsum">${summary}</div>` : ''}`,
  );
  const rows = recs.map((r) => {
    const done = isAttended(r);
    const dx = diagnosesList(r, { withOthers: false }).slice(0, 3);
    const procs = proceduresDone(r, ctx.procs).map((x) => x.nombre);
    const nAtt = ctx.store.supportsAttachments() ? ctx.store.loadAttachments(r.id).length : 0;
    const rmeta = [
      r.f.operativo,
      r.f.medico_nombre,
      procs.length && (procs.length <= 2 ? procs.join(', ') : `${procs.length} procedimientos`),
      nAtt && `${nAtt} ${nAtt === 1 ? 'adjunto' : 'adjuntos'}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return html`<div class="prow${ctx.rec.id === r.id ? ' active' : ''}">
            <button type="button" class="pmain" data-a="open" data-id="${r.id}" title="Abrir atención">
              <span class="pname">${fmtDate(r.f.fecha_atencion) || 'Sin fecha'}</span>
              <span class="pmeta">${rmeta}</span>
              <span class="ptags">${dx.map((d) => html`<span class="tag">${d}</span>`)}${done ? '' : html`<span class="state pend">Por atender</span>`}</span>
            </button>
            <div class="pact">
              <button type="button" class="ib sm" data-a="copy" data-id="${r.id}" title="Copiar nota" aria-label="Copiar nota">${icon('copy')}</button>
              <button type="button" class="ib sm" data-a="pdf" data-id="${r.id}" title="Descargar PDF" aria-label="Descargar PDF" aria-haspopup="menu">${icon('pdf')}</button>
              <button type="button" class="ib sm danger" data-perm="clinico" data-a="del" data-id="${r.id}" title="Eliminar" aria-label="Eliminar atención">${icon('trash')}</button>
            </div>
          </div>`;
  });
  setHtml(
    $('#patAttentions'),
    recs.length
      ? html`<section class="pgroup"><h3><span>Atenciones de ${ctx.especialidadNombre}</span><span>${recs.length}</span></h3>${rows}</section>`
      : html`<div class="empty">Este paciente aún no tiene atenciones en esta especialidad.</div>`,
  );
}

/**
 * Fichas sin atenciones en esta especialidad (p. ej. creadas por error, o
 * cuya única atención se eliminó): se pueden eliminar.
 * @param {AppContext} ctx
 * @param {Paciente[]} all
 * @param {Map<string, Paciente>} byId
 * @param {PorPaciente} groups
 */
function renderOrphans(ctx, all, byId, groups) {
  // `all` ya viene ordenada por nombre.
  const list = all.filter((p) => isCanonicalPatient(byId, p) && !isDeletedPatient(p) && !(groups.get(p.id) || []).length);
  $('#orphBox').hidden = !list.length;
  if (!list.length) return;
  $('#orphTitle').textContent = `${list.length} ${list.length === 1 ? 'ficha sin atenciones' : 'fichas sin atenciones'}`;
  setHtml(
    $('#orphList'),
    html`${list.map(
      (p) => html`<div class="prow">
        <div class="pmain static">
          <span class="pname">${patientLabel(p)}</span>
          <span class="pmeta">${join([p.f.paciente_rut || 'sin RUT', p.f.paciente_fnac && fmtDate(p.f.paciente_fnac)].filter(Boolean), ' · ')}</span>
        </div>
        <div class="pact">
          <button type="button" class="ib sm danger" data-a="delp" data-p="${p.id}" title="Eliminar ficha" aria-label="Eliminar ficha de ${patientLabel(p)}">${icon('trash')}</button>
        </div>
      </div>`,
    )}`,
  );
}

/**
 * Posibles duplicados: pares de fichas que parecen la misma persona. Se
 * propone conservar la que tiene RUT; si ninguna o ambas, la de más atenciones.
 * @param {AppContext} ctx
 * @param {Map<string, Paciente>} all
 * @param {PorPaciente} groups
 */
function renderDuplicates(ctx, all, groups) {
  const pairs = findDuplicatePairs(all, ctx.store.loadNotDuplicates());
  $('#dupBox').hidden = !pairs.length;
  if (!pairs.length) return;
  $('#dupTitle').textContent = `${pairs.length} ${pairs.length === 1 ? 'posible duplicado' : 'posibles duplicados'}`;
  /** @param {Paciente} p */
  const count = (p) => (groups.get(p.id) || []).length;
  /** @param {Paciente} p */
  const card = (p) =>
    html`<button type="button" class="pmain" data-a="view" data-p="${p.id}" title="Ver ficha">
      <span class="pname">${patientLabel(p)}</span>
      <span class="pmeta">${join([p.f.paciente_rut || 'sin RUT', p.f.paciente_fnac && fmtDate(p.f.paciente_fnac), `${count(p)} ${count(p) === 1 ? 'atención' : 'atenciones'}`].filter(Boolean), ' · ')}</span>
    </button>`;
  setHtml(
    $('#dupList'),
    html`${pairs.map(({ a, b, motivo }) => {
      /** @param {Paciente} p */
      const score = (p) => (p.f.paciente_rut ? 1e6 : 0) + count(p) * 10 - (p.created || 0) / 1e13;
      const [keep, drop] = score(a) >= score(b) ? [a, b] : [b, a];
      return html`<div class="duprow">
        <div class="duppair">${card(keep)}${card(drop)}</div>
        <div class="dupact">
          <span class="tag soft">${motivo === 'rut' ? 'Mismo RUT' : 'Mismo nombre'}</span>
          <button type="button" class="btn sm" data-a="distinct" data-keep="${keep.id}" data-drop="${drop.id}">Son personas distintas</button>
          <button type="button" class="btn sm p" data-a="merge" data-keep="${keep.id}" data-drop="${drop.id}">Unir en ${patientLabel(keep)}</button>
        </div>
      </div>`;
    })}`,
  );
}
