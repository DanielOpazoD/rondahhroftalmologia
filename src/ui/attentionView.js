/**
 * Formulario de atención: dibuja casillas y procedimientos, enlaza entradas
 * con el registro en edición y lo refleja en pantalla (`sync`).
 */
import { ANTECEDENTES, SOLICITADOS, DIAGNOSTICOS, TEXT_FIELDS, OJOS, coversEye, diagnosesList } from '../specialties/activa/index.js';
import { formatRut, isIsoDate, fmtDateTime, fmtDate } from '../core/format.js';
import { auditLabel, shortValue } from '../core/audit.js';
import { patientIdFor, attentionsOf } from '../core/patient.js';
import { refreshRutMarks } from './rut.js';
import { validateRecord, applyBirthDate, findDuplicate } from '../core/record.js';
import { renderCatalogSelects } from './catalogView.js';
import { initSexSelector, renderSexSelector, renderLegacyName } from './patientFields.js';
import { refreshNames } from '../core/names.js';
import { $, $$, toast, dataOf } from './dom.js';
import { renderAttachments } from './attachmentsView.js';
import { html, setHtml } from './html.js';

/** @typedef {import('./context.js').AppContext} AppContext */
/** @typedef {import('../domain').Atencion} Atencion */

/**
 * Elemento más cercano al destino del evento que cumple `sel` (o null).
 * @param {Event} e
 * @param {string} sel
 */
const closestTo = (e, sel) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(sel));

/**
 * Procedimientos de la atención en edición tal como los escribe el formulario:
 * texto por clave (ojo, PIO y descripción de cada ojo).
 * @param {AppContext} ctx
 */
const procsOf = (ctx) => /** @type {Record<string, Record<string, string>>} */ (ctx.rec.proc);

/**
 * Id del procedimiento de la fila (`.proc`) que contiene `el`.
 * @param {Element} el
 */
const procIdOf = (el) => dataOf(/** @type {HTMLElement} */ (el.closest('.proc')), 'id');

/**
 * La atención en edición con su tipo de dominio (el contexto la declara con la
 * forma de una atención en blanco, ver core/record.js).
 * @param {AppContext} ctx
 */
const editingOf = (ctx) => /** @type {Atencion} */ (ctx.rec);

/** @param {AppContext} ctx */
export function initAttentionView(ctx) {
  $('#remoteClose').addEventListener('click', () => ($('#remoteBanner').hidden = true));
  /**
   * @param {HTMLElement} el
   * @param {{key: string, label: string}[]} defs
   */
  const chips = (el, defs) => {
    setHtml(
      el,
      html`${defs.map((d) => html`<button type="button" class="chip" data-k="${d.key}" aria-pressed="false">${d.label}</button>`)}`,
    );
    el.addEventListener('click', (e) => {
      const b = closestTo(e, '.chip');
      if (!b) return;
      const rec = ctx.rec;
      const k = dataOf(b, 'k');
      rec.checks[k] = !rec.checks[k];
      ctx.changed();
    });
  };
  chips($('#antChips'), ANTECEDENTES);
  chips($('#solChips'), SOLICITADOS);
  chips($('#dxChips'), DIAGNOSTICOS);

  /**
   * @param {HTMLElement} el
   * @param {string[]} values
   * @param {string[]} labels
   * @param {(v: string) => void} onPick
   */
  const seg = (el, values, labels, onPick) => {
    setHtml(el, html`${values.map((v, i) => html`<button type="button" data-v="${v}" aria-pressed="false">${labels[i]}</button>`)}`);
    el.addEventListener('click', (e) => {
      const b = closestTo(e, 'button');
      if (b) onPick(dataOf(b, 'v'));
    });
  };
  seg($('#catSeg'), OJOS, OJOS, (v) => {
    ctx.rec.cat = ctx.rec.cat === v ? '' : v;
    ctx.changed();
  });
  initSexSelector(
    $('#sexSeg'),
    () => ctx.rec.f.paciente_sexo || '',
    (v) => {
      ctx.rec.f.paciente_sexo = v;
      ctx.changed();
    },
  );

  renderProcList(ctx);
  const list = $('#procList');
  list.addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, '.seg button');
    if (!b) return;
    const id = procIdOf(b);
    const procs = procsOf(ctx);
    const cur = procs[id] || {};
    const eye = dataOf(b, 'v');
    cur.eye = cur.eye === eye ? '' : eye;
    if (!cur.eye) delete procs[id];
    else procs[id] = cur;
    ctx.changed();
  });
  list.addEventListener('input', (/** @type {InputEvent} */ e) => {
    const d = /** @type {HTMLInputElement | null} */ (closestTo(e, '.pdesc input'));
    if (d) {
      const id = procIdOf(d);
      const proc = procsOf(ctx)[id];
      if (!proc) return;
      const key = `desc_${dataOf(d, 'desc')}`;
      // La descripción única de la 2.18.0 pasa a ser la de cada ojo al editar.
      if (proc.desc !== undefined) {
        for (const eye of ['od', 'oi']) if (proc[`desc_${eye}`] === undefined && coversEye(proc.eye, eye)) proc[`desc_${eye}`] = proc.desc;
        delete proc.desc;
      }
      if (d.value.trim()) proc[key] = d.value;
      else delete proc[key];
      ctx.changed({ silent: true });
      return;
    }
    const i = /** @type {HTMLInputElement | null} */ (closestTo(e, '.pio input'));
    if (!i) return;
    const id = procIdOf(i);
    const procs = procsOf(ctx);
    procs[id] ||= { eye: 'AO' };
    procs[id][dataOf(i, 'e')] = i.value;
    ctx.changed({ silent: true });
  });

  // Campos de texto: un solo listener delegado.
  document.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    const k = target.id;
    if (TEXT_FIELDS.includes(k) && k !== 'paciente_sexo') {
      ctx.rec.f[k] = target.value;
      refreshNames(ctx.rec.f);
      $('#paciente_nombre').value = ctx.rec.f.paciente_nombre || '';
      renderLegacyName('paciente_', ctx.rec.f);
      // La edad se calcula sola desde la fecha de nacimiento.
      const ageChanged = (k === 'paciente_fnac' || k === 'fecha_atencion') && applyBirthDate(ctx.rec);
      if (k === 'paciente_fnac' && !isIsoDate(target.value)) $('#paciente_edad').readOnly = false;
      ctx.changed({ silent: !ageChanged && k !== 'paciente_fnac' });
    }
  });
  $('#dupJoin').addEventListener('click', () => ctx.joinExisting($('#dupBanner').dataset.id));
  $('#paciente_rut').addEventListener('blur', (/** @type {FocusEvent} */ e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (!input.value.trim()) return;
    ctx.rec.f.paciente_rut = formatRut(input.value);
    ctx.changed();
    // Paciente ya registrado: se completan sus datos desde la ficha.
    if (ctx.fillFromPatient()) toast('Paciente registrado: se completaron sus datos');
  });
  $('#patPrev').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const b = closestTo(e, 'button[data-id]');
    if (b) ctx.openRecord(dataOf(b, 'id'));
  });
}

/**
 * Dibuja la lista de procedimientos según la configuración actual.
 * @param {AppContext} ctx
 */
export function renderProcList(ctx) {
  setHtml(
    $('#procList'),
    html`${ctx.procs.map(
      (p) => html`<div class="proc" data-id="${p.id}"><div class="nm">${p.n}</div>
      <div class="seg" role="group" aria-label="Ojo para ${p.n}">${OJOS.map((v) => html`<button type="button" data-v="${v}" aria-pressed="false">${v}</button>`)}</div>
      ${p.pio ? html`<div class="pio">${['od', 'oi'].map((e) => html`<label class="pf"><span>PIO ${e.toUpperCase()}</span><input data-e="${e}" aria-label="PIO ${e.toUpperCase()} ${p.n}" placeholder="mmHg" inputmode="decimal"></label>`)}</div>` : ''}
      ${p.desc ? html`<div class="pdesc">${['od', 'oi'].map((e) => html`<label class="pf"><span>${e.toUpperCase()}</span><input data-desc="${e}" aria-label="Descripción ${e.toUpperCase()} de ${p.n}" placeholder="Descripción ${e.toUpperCase()} (opcional)" maxlength="400"></label>`)}</div>` : ''}</div>`,
    )}`,
  );
  ctx.applyPermissions?.(); // filas nuevas: solo lectura si la persona no edita lo clínico
}

/**
 * @param {Element} b
 * @param {boolean} on
 */
const setPressed = (b, on) => {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
};

/**
 * Refleja el registro en edición en el formulario.
 * @param {AppContext} ctx
 */
export function syncAttentionView(ctx) {
  const rec = ctx.rec;
  refreshNames(rec.f);
  renderLegacyName('paciente_', rec.f);
  // El aviso de cambios de otro equipo es de una atención: se oculta al cambiar de atención.
  const notice = $('#remoteBanner');
  if (!notice.hidden && notice.dataset.id !== rec.id) notice.hidden = true;
  for (const k of TEXT_FIELDS) {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(k));
    if (el && el.value !== (rec.f[k] || '')) el.value = rec.f[k] || '';
  }
  $$('.chip[data-k]').forEach((c) => setPressed(c, !!rec.checks[c.dataset.k]));
  $('#cxBox').hidden = !rec.checks.antecedente_cirugia;
  $('#schBox').hidden = !rec.checks.procedimiento_test_schirmer;
  $('#catBox').hidden = !rec.checks.diagnostico_catarata;
  $$('#catSeg button').forEach((b) => setPressed(b, b.dataset.v === rec.cat));
  renderSexSelector($('#sexSeg'), rec.f.paciente_sexo || '');

  let n = 0;
  const procs = procsOf(ctx);
  $$('#procList .proc').forEach((/** @type {HTMLElement} */ row) => {
    const p = procs[dataOf(row, 'id')];
    row.classList.toggle('done', !!p);
    if (p) n++;
    /** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.seg button')).forEach((b) =>
      setPressed(b, !!p && p.eye === b.dataset.v),
    );
    /** @type {NodeListOf<HTMLInputElement>} */ (row.querySelectorAll('.pio input')).forEach((i) => {
      const eye = dataOf(i, 'e');
      const v = p ? p[eye] || '' : '';
      if (i.value !== v) i.value = v;
      /** @type {HTMLElement} */ (i.closest('.pf')).hidden = !!p && !coversEye(p.eye, eye);
    });
    /** @type {NodeListOf<HTMLInputElement>} */ (row.querySelectorAll('.pdesc input')).forEach((d) => {
      const e = /** @type {'od' | 'oi'} */ (d.dataset.desc);
      // La del ojo (o la única de la 2.18.0), solo si el ojo está marcado.
      const v = p && coversEye(p.eye, e) ? String(p[`desc_${e}`] ?? p.desc ?? '') : '';
      if (d.value !== v && document.activeElement !== d) d.value = v;
      // Solo la del ojo marcado (con AO, las dos).
      /** @type {HTMLElement} */ (d.closest('.pf')).hidden = !!p && !coversEye(p.eye, e);
    });
  });
  $('#procBadge').textContent = n;
  const fromBirth = isIsoDate(rec.f.paciente_fnac);
  $('#paciente_edad').readOnly = fromBirth;
  $('#paciente_edad').title = fromBirth ? 'Calculada desde la fecha de nacimiento' : '';
  renderCatalogSelects(ctx);
  renderPrevious(ctx);
  refreshRutMarks();
  renderHistory(ctx);
  renderToolbar(ctx);
  showValidation(ctx);
  void renderAttachments(ctx);
}

/**
 * Atención nueva de un paciente (mismo RUT o nombre) que ya tiene una ese
 * día; null si la abierta ya está guardada o aún no identifica al paciente.
 * @param {AppContext} ctx
 */
function duplicateOf(ctx) {
  const f = ctx.rec.f;
  const identified = f.paciente_rut?.trim() || f.paciente_nombre?.trim();
  return !ctx.rec.id && identified ? findDuplicate(editingOf(ctx), ctx.records) : null;
}

/**
 * Estado de guardado para la barra. Con guardado automático, «sin guardar»
 * solo dura la pausa al escribir, salvo que algo lo impida.
 * @param {AppContext} ctx
 * @param {boolean} dup ¿hay otra atención del paciente ese día?
 */
function saveState(ctx, dup) {
  if (!ctx.dirty) return ctx.rec.id ? 'Guardada' : 'Sin datos';
  const blocking = validateRecord(editingOf(ctx)).errors[0];
  if (blocking) return `Sin guardar · ${blocking}`;
  return dup ? 'Sin guardar · continúa en la atención existente' : 'Guardando…';
}

/**
 * Título y estado de la barra superior: a quién se atiende y si hay cambios sin guardar.
 * @param {AppContext} ctx
 */
export function renderToolbar(ctx) {
  const f = ctx.rec.f;
  const dup = duplicateOf(ctx);
  $('#dupBanner').hidden = !dup;
  if (dup) {
    $('#dupBanner').dataset.id = dup.id;
    $('#dupText').textContent =
      `${dup.f.paciente_nombre || dup.f.paciente_rut} ya tiene una atención este día (en este u otro equipo). Continúa en ella para no duplicar: lo que escribiste se agrega.`;
  }
  $('#tbName').textContent = f.paciente_nombre?.trim() || (ctx.rec.id ? '(sin nombre)' : 'Nueva atención');
  const el = $('#tbState');
  el.textContent = saveState(ctx, Boolean(dup));
  el.className = ctx.dirty ? 'dirty' : ctx.rec.id ? 'saved' : '';
}

/**
 * Muestra mensajes de validación junto a los campos.
 * Las advertencias se ven mientras se escribe; los errores, solo al intentar guardar.
 * @param {AppContext} ctx
 * @param {{showErrors?: boolean}} [o]
 */
export function showValidation(ctx, { showErrors = false } = {}) {
  const { fields } = validateRecord(editingOf(ctx));
  $$('.msg').forEach((m) => {
    const k = m.dataset.msg;
    const item = fields[k];
    const show = !!item && (item.level === 'warn' || showErrors);
    m.textContent = show ? item.msg : '';
    m.className = 'msg' + (show ? (item.level === 'error' ? ' err' : ' warn') : '');
    const input = document.getElementById(k);
    if (input && input.tagName === 'INPUT') {
      input.classList.toggle('invalid', show && item.level === 'error');
      input.classList.toggle('warned', show && item.level === 'warn');
      input.setAttribute('aria-invalid', String(show));
      // El lector de pantalla lee el mensaje al llegar al campo.
      m.id ||= 'msg_' + k;
      input.setAttribute('aria-describedby', m.id);
    }
  });
}

/** @type {Record<string, string>} */
const TIPO = { ingresada: 'Ingresada a la lista', creada: 'Creada', editada: 'Editada', eliminada: 'Eliminada' };

/** Temporizador del aviso de cambios de otro equipo. @type {ReturnType<typeof setTimeout> | undefined} */
let remoteTimer;

/**
 * Aviso (en la atención, no un mensaje pasajero) de lo que cambió otro
 * equipo en la atención abierta. Se cierra solo, con «Entendido» o al abrir
 * otra atención.
 * @param {string} id atención a la que se refiere
 * @param {string} text
 */
export function showRemoteNotice(id, text) {
  const b = $('#remoteBanner');
  b.dataset.id = id;
  $('#remoteText').textContent = text;
  b.hidden = false;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => (b.hidden = true), 30_000);
}

/**
 * Resalta un momento los campos que cambiaron (rutas f.*, checks.*, cat,
 * proc.<id>.*), p. ej. al llegar cambios de otro equipo.
 * @param {string[]} paths
 */
export function flashFields(paths) {
  /** @type {Set<Element>} */
  const els = new Set();
  for (const p of paths) {
    /** @type {Element | null | undefined} */
    let el = null;
    if (p.startsWith('f.')) el = document.getElementById(p.slice(2));
    else if (p.startsWith('checks.')) el = document.querySelector(`.chip[data-k="${CSS.escape(p.slice(7))}"]`);
    else if (p === 'cat') el = document.getElementById('catSeg');
    else if (p.startsWith('proc.')) el = document.querySelector(`#procList .proc[data-id="${CSS.escape(p.slice(5, p.lastIndexOf('.')))}"]`);
    if (el) els.add(el);
  }
  for (const el of els) {
    el.classList.remove('remote');
    void (/** @type {HTMLElement} */ (el).offsetWidth); // reinicia la animación
    el.classList.add('remote');
    setTimeout(() => el.classList.remove('remote'), 3000);
  }
}

/**
 * Historial de cambios (bitácora) de la atención abierta.
 * @param {AppContext} ctx
 */
export function renderHistory(ctx) {
  const id = ctx.rec.id;
  const entries = id ? ctx.store.auditFor(id) : [];
  $('#histCard').hidden = !entries.length;
  $('#histCount').textContent = entries.length;
  setHtml(
    $('#histList'),
    html`${entries.map((e) => {
      const cambios = (e.cambios || [])
        .slice(0, 30)
        .map(
          (c) =>
            html`<li>${auditLabel(c.c, ctx.procs)}: <span class="hval">${shortValue(c.a)}</span> → <span class="hval">${shortValue(c.d)}</span></li>`,
        );
      const more = (e.cambios || []).length > 30 ? html`<li>… y ${e.cambios.length - 30} cambios más</li>` : '';
      return html`<li><div class="hmeta"><b>${TIPO[e.tipo] || e.tipo}</b> · ${fmtDateTime(new Date(e.at))} · ${e.autor ? html`${e.autor} <span class="muted">(${e.equipo})</span>` : e.equipo}</div>${cambios.length || more ? html`<ul>${cambios}${more}</ul>` : ''}</li>`;
    })}`,
  );
}

/**
 * Otras atenciones del mismo paciente (historial clínico a lo largo del tiempo).
 * @param {AppContext} ctx
 */
function renderPrevious(ctx) {
  const id = ctx.rec.pacienteId || patientIdFor(ctx.rec.f);
  const others = id ? attentionsOf(ctx.records, id).filter((r) => r.id !== ctx.rec.id) : [];
  $('#patPrev').hidden = !others.length;
  const prevButtons = others.slice(0, 6).map((r) => {
    const dx = diagnosesList(r, { withOthers: false }).slice(0, 2).join(', ');
    return html`<button type="button" data-id="${r.id}" title="Abrir">${fmtDate(r.f.fecha_atencion)}${dx ? ' · ' + dx : ''}</button>`;
  });
  const prevMore = others.length > 6 ? html`<span class="muted">y ${others.length - 6} más (ver en Pacientes)</span>` : '';
  setHtml($('#patPrev'), others.length ? html`<b>Otras atenciones (${others.length}):</b>${prevButtons}${prevMore}` : html``);
}
