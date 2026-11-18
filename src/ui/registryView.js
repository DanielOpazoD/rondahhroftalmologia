/**
 * Pestaña Pacientes: una sola lista. Cada paciente se despliega en su lugar
 * (sin otra pantalla ni «volver») y muestra sus datos, sus acciones y su
 * historial de atenciones de esta especialidad.
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

/** Pacientes por página: se dibujan de a tantos (el DOM no crece sin tope). */
const PAGE = 500;
/** Cuántos se muestran ahora (sube con «Mostrar más»). */
let shown = PAGE;

/** @param {AppContext} ctx */
export function initRegistryView(ctx) {
  ctx.openPatientId = null;
  // Una búsqueda o un operativo nuevos vuelven a la primera página.
  $('#regSearch').addEventListener('input', () => ((shown = PAGE), renderRegistry(ctx)));
  $('#regOp').addEventListener('change', () => ((shown = PAGE), renderRegistry(ctx)));
  $('#regList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-p]');
    if (b) return togglePatient(ctx, dataOf(b, 'p'));
    if (closestTo(e, '#regMore')) {
      const first = shown;
      shown += PAGE;
      renderRegistry(ctx);
      // El botón se reemplaza al dibujar: el foco pasa a la primera fila nueva (no se pierde en la página).
      return /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#regList button[data-p]'))[first]?.focus();
    }
    if (closestTo(e, '#patNew')) return ctx.openPatientId && ctx.newAttentionFor(ctx.openPatientId);
    if (closestTo(e, '#patEdit')) return ctx.openPatientId && ctx.editPatient(ctx.openPatientId);
    attentionAction(ctx, /** @type {HTMLButtonElement | null} */ (closestTo(e, '#patAttentions button[data-a]')));
  });
  $('#dupList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'merge') ctx.mergePatients(dataOf(b, 'keep'), dataOf(b, 'drop'));
    if (b.dataset.a === 'distinct') ctx.notDuplicates(dataOf(b, 'keep'), dataOf(b, 'drop'));
    if (b.dataset.a === 'view') revealPatient(ctx, dataOf(b, 'p'));
  });
  $('#orphList').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-a]');
    if (b?.dataset.a === 'delp') void ctx.deletePatient(dataOf(b, 'p'));
  });
}

/**
 * Acción sobre una atención del paciente desplegado (abrir, PDF, nota, eliminar).
 * @param {AppContext} ctx
 * @param {HTMLButtonElement | null} b
 */
function attentionAction(ctx, b) {
  const rec = b && ctx.records.find((r) => r.id === b.dataset.id);
  if (!b || !rec) return;
  /** @type {Record<string, () => unknown>} */
  const actions = {
    open: () => ctx.openRecord(rec.id),
    pdf: () => ctx.downloadPdf(rec, b),
    copy: () => ctx.copyNote(rec),
    del: () => ctx.deleteRecord(rec.id),
  };
  actions[dataOf(b, 'a')]?.();
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
 * Despliega la ficha (o la pliega, si ya estaba abierta). Una a la vez.
 * @param {AppContext} ctx
 * @param {string} id
 */
function togglePatient(ctx, id) {
  ctx.openPatientId = ctx.openPatientId === id ? null : id;
  if (ctx.openPatientId) ctx.accounts?.event('ficha.ver', id);
  renderRegistry(ctx);
  focusPatient(id);
}

/**
 * Despliega una ficha aunque la búsqueda la oculte (p. ej. desde «Posibles duplicados»).
 * @param {AppContext} ctx
 * @param {string} id
 */
function revealPatient(ctx, id) {
  $('#regSearch').value = '';
  $('#regOp').value = '';
  shown = PAGE;
  ctx.openPatientId = null;
  togglePatient(ctx, id);
}

/** Mantiene a la vista y con el foco la fila de la ficha. @param {string} id */
function focusPatient(id) {
  const row = /** @type {HTMLElement | null} */ (document.querySelector(`#regList button[data-p="${CSS.escape(id)}"]`));
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest' });
}

/** @param {AppContext} ctx */
export function renderRegistry(ctx) {
  const future = ctx.store.loadFutureRecords().length;
  $('#futureBanner').hidden = !future;
  $('#futureBanner').textContent = future
    ? `Hay ${future} atención(es) guardadas con una versión más nueva de la app. Recarga la página para verlas y editarlas.`
    : '';
  const groups = byPatient(ctx.records);

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
  $('#regCount').textContent = String(patients.length);
  // La ficha desplegada siempre se dibuja, aunque esté más allá de las páginas mostradas.
  const openAt = ctx.openPatientId ? patients.findIndex(({ p }) => p.id === ctx.openPatientId) : -1;
  if (openAt >= shown) shown = (Math.floor(openAt / PAGE) + 1) * PAGE;
  if (!patients.length) {
    const empty = ctx.records.length
      ? 'Sin resultados para esta búsqueda.'
      : html`Aún no hay pacientes.<br>Ingrésalos en la pestaña Ingreso o desde una atención.`;
    setHtml($('#regList'), html`<div class="empty">${empty}</div>`);
    return;
  }
  const rows = patients.slice(0, shown).map(({ p, recs }) => patientRow(ctx, p, recs));
  const rest = patients.length - shown;
  const more =
    rest > 0
      ? html`<div class="row u-gap8 listmore"><button type="button" class="btn sm" id="regMore">Mostrar ${Math.min(rest, PAGE)} más</button><span class="hint">${rest} sin mostrar (los más antiguos)</span></div>`
      : '';
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
 * Datos de la ficha desplegada que no están ya en su fila (RUT, edad y sexo sí lo están):
 * nacimiento, fono y si el RUT es válido.
 * @param {Paciente} p
 */
function patientMeta(p) {
  const f = p.f;
  return [
    f.paciente_rut && html`RUT${rutMark(f.paciente_rut)}`,
    f.paciente_fnac && html`Nac. ${fmtDate(f.paciente_fnac)}`,
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

/** Iniciales para la marca de la fila («Ana Tepano» → «AT»). @param {Paciente} p */
function initials(p) {
  const words = patientLabel(p).split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0])
      .join('') || '?'
  ).toUpperCase();
}

/**
 * Fila de un paciente y, si está desplegado, su ficha y sus atenciones debajo.
 * @param {AppContext} ctx
 * @param {Paciente} p
 * @param {AtencionGuardada[]} recs de la más reciente a la más antigua (al menos una)
 */
function patientRow(ctx, p, recs) {
  const open = ctx.openPatientId === p.id;
  const last = recs[0];
  const age = ageNow(p, last.f.paciente_edad);
  const meta = [p.f.paciente_rut || 'sin RUT', age !== '' && age != null ? `${age} años` : '', sexLabel(p.f.paciente_sexo)]
    .filter(Boolean)
    .join(' · ');
  const dx = diagnosesList(last, { withOthers: false }).slice(0, 2);
  const pending = recs.some((r) => !isAttended(r));
  const count = `${recs.length} ${recs.length === 1 ? 'atención' : 'atenciones'}`;
  return html`<div class="pitem${open ? ' open' : ''}">
    <div class="prow">
      <button type="button" class="pmain ppat" data-p="${p.id}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Plegar' : 'Ver atenciones'}">
        <span class="pavatar" aria-hidden="true">${initials(p)}</span>
        <span class="pname">${patientLabel(p)}</span>
        <span class="pmeta">${meta}</span>
        <span class="ptags">${pending ? html`<span class="state pend">Por atender</span>` : ''}${dx.map((d) => html`<span class="tag">${d}</span>`)}</span>
        <span class="plast"><span>${fmtDate(last.f.fecha_atencion) || 'Sin fecha'}</span><small>${count}</small></span>
        <svg class="chev" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
      </button>
    </div>
    ${open ? patientDetail(ctx, p, recs) : ''}
  </div>`;
}

/**
 * Ficha desplegada: datos, acciones y atenciones (los ids son únicos: se despliega una a la vez).
 * @param {AppContext} ctx
 * @param {Paciente} p
 * @param {AtencionGuardada[]} recs
 */
function patientDetail(ctx, p, recs) {
  const meta = patientMeta(p);
  const summary = patientSummary(recs, ctx.especialidadNombre);
  const rows = recs.map((r) => attentionRow(ctx, r));
  return html`<div class="pdetail">
    <div class="patcard" id="patCard">
      <div id="patCardInfo"><h2 class="vh">${patientLabel(p)}</h2><div class="patmeta">${join(meta, ' · ')}</div>${summary ? html`<div class="patsum">${summary}</div>` : ''}</div>
      <div class="row u-gap8">
        <button type="button" class="btn sm" id="patEdit">${icon('edit')}Editar datos</button>
        <button type="button" class="btn p sm" id="patNew" data-perm="clinico">${icon('plus')}Nueva atención</button>
      </div>
    </div>
    <div id="patAttentions" class="plist">${rows}</div>
  </div>`;
}

/**
 * Una atención en la ficha desplegada.
 * @param {AppContext} ctx
 * @param {AtencionGuardada} r
 */
function attentionRow(ctx, r) {
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
