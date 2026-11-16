/**
 * Perfiles profesionales y operativos: selectores del formulario y gestión en Ajustes.
 * Elegir un médico rellena su nombre y RUT en la atención (solo los perfiles
 * con rol médico); elegir un operativo rellena su nombre. Los perfiles también
 * dicen quién registra (ver userView.js). Ambos catálogos se sincronizan.
 */
import { isValidRut } from '../core/format.js';
import { makeMedico, makeOperativo, findMedico, onlyDoctors, rolLabel } from '../core/catalog.js';
import { ROLES } from '../config/catalogs.js';
import { $ } from './dom.js';
import { html, setHtml } from './html.js';
import { openDialog } from './dialog.js';
import { clock } from '../core/clock.js';
import { uiConfirm } from './modal.js';
import { icon } from './icons.js';
import { NAME_PARTS, nameParts, personName } from '../core/names.js';
import { profileNameFields, profileNameValues } from './patientFields.js';

const NEW = '__nuevo';
const CUR = '__actual';

/** @typedef {import('./context.js').AppContext} AppContext */
/** @typedef {import('../domain').Perfil} Medico */
/** @typedef {import('../domain').Operativo} Operativo */
/** @typedef {'medico' | 'operativo'} TipoCatalogo */

/** @param {AppContext} ctx */
export function initCatalogView(ctx) {
  $('#operativoSel').addEventListener('change', (/** @type {Event} */ e) => {
    const v = /** @type {HTMLSelectElement} */ (e.target).value;
    if (v === NEW) return editOperativo(ctx, null, (o) => setOperativo(ctx, o?.nombre));
    if (v !== CUR) setOperativo(ctx, v);
  });
  $('#medicoSel').addEventListener('change', (/** @type {Event} */ e) => {
    const v = /** @type {HTMLSelectElement} */ (e.target).value;
    if (v === NEW) return editProfile(ctx, { rol: 'medico' }, (m) => setMedico(ctx, m));
    if (v !== CUR) setMedico(ctx, ctx.medicos.find((m) => m.id === v) || null);
  });

  $('#medAdd').addEventListener('click', () => editProfile(ctx));
  $('#opAdd').addEventListener('click', () => editOperativo(ctx));
  /** @param {TipoCatalogo} kind */
  const listClick = (kind) => async (/** @type {MouseEvent} */ e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('button[data-a]'));
    if (!b) return;
    const list = kind === 'medico' ? ctx.medicos : ctx.operativos;
    const item = list.find((x) => x.id === b.dataset.id);
    if (!item) return;
    if (b.dataset.a === 'edit') return kind === 'medico' ? editProfile(ctx, item) : editOperativo(ctx, item);
    if (b.dataset.a !== 'del') return;
    const ok = await uiConfirm({
      title: kind === 'medico' ? 'Eliminar perfil' : 'Eliminar operativo',
      message: `«${item.nombre}» se quitará de la lista en todos los equipos. Las atenciones ya guardadas no cambian.`,
      tone: 'danger',
      okLabel: 'Eliminar',
    });
    if (ok) ctx.deleteCatalog(kind, item.id);
  };
  $('#medList').addEventListener('click', listClick('medico'));
  $('#opList').addEventListener('click', listClick('operativo'));
}

/**
 * Pone el operativo en la atención; undefined (diálogo cancelado) solo re-dibuja los selectores.
 * @param {AppContext} ctx
 * @param {string | undefined} nombre
 */
function setOperativo(ctx, nombre) {
  if (nombre !== undefined) {
    ctx.rec.f.operativo = nombre || '';
    ctx.changed();
  } else renderCatalogSelects(ctx);
}

/**
 * Pone el médico en la atención (null: ninguno); undefined (diálogo cancelado) solo re-dibuja los selectores.
 * @param {AppContext} ctx
 * @param {Medico | null | undefined} m
 */
function setMedico(ctx, m) {
  if (m === undefined) return renderCatalogSelects(ctx);
  ctx.rec.f.medico_nombre = m?.nombre || '';
  ctx.rec.f.medico_rut = m?.rut || '';
  for (const k of NAME_PARTS) delete ctx.rec.f['medico_' + k];
  Object.assign(ctx.rec.f, Object.fromEntries(Object.entries(nameParts(m || {})).map(([k, v]) => ['medico_' + k, v])));
  ctx.changed();
}

/**
 * Diálogo de perfil profesional. `m` es el perfil a editar, o valores
 * iniciales de uno nuevo (p. ej. `{rol: 'medico'}`). `done(m)` recibe el
 * perfil guardado, o undefined si se canceló.
 * @param {AppContext} ctx
 * @param {Partial<Medico> | null} [m]
 * @param {(m: Medico | undefined) => void} [done]
 */
export function editProfile(ctx, m = null, done) {
  /** @type {Medico | undefined} */
  let result;
  const editing = Boolean(m?.id);
  openDialog({
    title: editing ? 'Editar perfil' : 'Nuevo perfil',
    fields: [
      ...profileNameFields(m || {}),
      { id: 'rol', label: 'Rol', value: m?.rol || 'medico', options: ROLES.map((r) => ({ value: r.key, label: r.label })) },
      { id: 'rut', label: 'RUT', value: m?.rut, placeholder: '12.345.678-9' },
    ],
    onSave: (values) => {
      const { rut, rol } = values;
      const parts = profileNameValues(values, m || {});
      if (!personName(parts)) return 'Escribe los nombres y apellidos';
      if (rut && !isValidRut(rut)) return 'RUT con dígito verificador inválido';
      const item = makeMedico({ ...m, ...parts, rut, rol, updated: clock.tick() });
      if (!item) return 'Escribe los nombres y apellidos';
      result = ctx.saveCatalog('medico', item);
      return null;
    },
    onClose: () => done?.(result),
  });
}

/**
 * Diálogo de operativo (`o`: el que se edita; null: uno nuevo). `done(o)` recibe
 * el operativo guardado, o undefined si se canceló.
 * @param {AppContext} ctx
 * @param {Operativo | null} [o]
 * @param {(o: Operativo | undefined) => void} [done]
 */
function editOperativo(ctx, o = null, done) {
  /** @type {Operativo | undefined} */
  let result;
  openDialog({
    title: o ? 'Editar operativo' : 'Nuevo operativo',
    fields: [{ id: 'nombre', label: 'Nombre del operativo o ronda', value: o?.nombre, placeholder: 'Ej: Operativo Oftalmología Nov 2026' }],
    onSave: ({ nombre }) => {
      if (!nombre) return 'Escribe el nombre';
      const dup = ctx.operativos.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase() && x.id !== o?.id);
      if (dup) return 'Ya existe un operativo con ese nombre';
      const item = makeOperativo({ ...o, nombre, updated: clock.tick() });
      if (!item) return 'Escribe el nombre';
      result = ctx.saveCatalog('operativo', item);
      return null;
    },
    onClose: () => done?.(result),
  });
}

/**
 * Opciones de los selectores del formulario según la atención en edición.
 * @param {AppContext} ctx
 */
export function renderCatalogSelects(ctx) {
  const f = ctx.rec.f;
  const op = f.operativo || '';
  const opNames = ctx.operativos.map((o) => o.nombre);
  const curOp = op && !opNames.includes(op) ? html`<option value="${CUR}">${op}</option>` : '';
  const opOptions = opNames.map((n) => html`<option value="${n}">${n}</option>`);
  setHtml(
    $('#operativoSel'),
    html`<option value="">Sin operativo</option>${curOp}${opOptions}<option value="${NEW}">＋ Nuevo operativo…</option>`,
  );
  $('#operativoSel').value = op ? (opNames.includes(op) ? op : CUR) : '';

  const doctors = onlyDoctors(ctx.medicos);
  const m = findMedico(doctors, f.medico_nombre, f.medico_rut);
  const hasOther = !m && f.medico_nombre;
  const curMed = hasOther ? html`<option value="${CUR}">${f.medico_nombre}</option>` : '';
  const medOptions = doctors.map((x) => html`<option value="${x.id}">${x.nombre}${x.rut ? ' · ' + x.rut : ''}</option>`);
  setHtml(
    $('#medicoSel'),
    html`<option value="">Sin médico</option>${curMed}${medOptions}<option value="${NEW}">＋ Nuevo médico…</option>`,
  );
  $('#medicoSel').value = m ? m.id : hasOther ? CUR : '';
}

/**
 * Listas de perfiles y operativos en Ajustes.
 * @param {AppContext} ctx
 */
export function renderCatalogSettings(ctx) {
  /**
   * @param {Medico | Operativo} x
   * @param {string} [sub] detalle bajo el nombre
   */
  const row = (x, sub) => html`<div class="it"><div class="t"><b>${x.nombre}</b>${sub ? html`<span class="muted">${sub}</span>` : ''}</div>
    <button type="button" class="ib sm" data-perm="ajustes" data-a="edit" data-id="${x.id}" title="Editar" aria-label="Editar">${icon('edit')}</button>
    <button type="button" class="ib sm danger" data-perm="ajustes" data-a="del" data-id="${x.id}" title="Eliminar" aria-label="Eliminar">${icon('trash')}</button></div>`;
  setHtml(
    $('#medList'),
    ctx.medicos.length
      ? html`${ctx.medicos.map((m) => row(m, [rolLabel(m.rol), m.rut].filter(Boolean).join(' · ')))}`
      : html`<p class="hint">Aún no hay perfiles.</p>`,
  );
  setHtml(
    $('#opList'),
    ctx.operativos.length ? html`${ctx.operativos.map((o) => row(o))}` : html`<p class="hint">Aún no hay operativos.</p>`,
  );
  $('#medCount').textContent = ctx.medicos.length;
  $('#opCount').textContent = ctx.operativos.length;
}
