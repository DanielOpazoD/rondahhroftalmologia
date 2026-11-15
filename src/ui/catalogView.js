/**
 * Perfiles de médico y operativos: selectores del formulario y gestión en Ajustes.
 * Elegir un médico rellena su nombre y RUT en la atención; elegir un operativo
 * rellena su nombre. Ambos catálogos se sincronizan entre equipos.
 */
import { escapeHtml, isValidRut } from '../core/format.js';
import { makeMedico, makeOperativo, findMedico } from '../core/catalog.js';
import { $ } from './dom.js';
import { openDialog } from './dialog.js';
import { uiConfirm } from './modal.js';

const NEW = '__nuevo';
const CUR = '__actual';
const ICON = (n) => `<svg><use href="#i-${n}"/></svg>`;

/** @param {import('./context.js').AppContext} ctx */
export function initCatalogView(ctx) {
  $('#operativoSel').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === NEW) return editOperativo(ctx, null, (o) => setOperativo(ctx, o?.nombre));
    if (v !== CUR) setOperativo(ctx, v);
  });
  $('#medicoSel').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === NEW) return editMedico(ctx, null, (m) => setMedico(ctx, m));
    if (v !== CUR) setMedico(ctx, ctx.medicos.find((m) => m.id === v) || null);
  });

  $('#medAdd').addEventListener('click', () => editMedico(ctx));
  $('#opAdd').addEventListener('click', () => editOperativo(ctx));
  const listClick = (kind) => async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const list = kind === 'medico' ? ctx.medicos : ctx.operativos;
    const item = list.find((x) => x.id === b.dataset.id);
    if (!item) return;
    if (b.dataset.a === 'edit') return kind === 'medico' ? editMedico(ctx, item) : editOperativo(ctx, item);
    if (b.dataset.a !== 'del') return;
    const ok = await uiConfirm({
      title: kind === 'medico' ? 'Eliminar médico' : 'Eliminar operativo',
      message: `«${item.nombre}» se quitará de la lista en todos los equipos. Las atenciones ya guardadas no cambian.`,
      tone: 'danger',
      okLabel: 'Eliminar',
    });
    if (ok) ctx.deleteCatalog(kind, item.id);
  };
  $('#medList').addEventListener('click', listClick('medico'));
  $('#opList').addEventListener('click', listClick('operativo'));
}

function setOperativo(ctx, nombre) {
  if (nombre !== undefined) {
    ctx.rec.f.operativo = nombre || '';
    ctx.changed();
  } else renderCatalogSelects(ctx);
}

function setMedico(ctx, m) {
  if (m === undefined) return renderCatalogSelects(ctx);
  ctx.rec.f.medico_nombre = m?.nombre || '';
  ctx.rec.f.medico_rut = m?.rut || '';
  ctx.changed();
}

/** Diálogo de médico. `done(m)` recibe el perfil guardado, o undefined si se canceló. */
function editMedico(ctx, m = null, done) {
  let result;
  openDialog({
    title: m ? 'Editar médico' : 'Nuevo médico',
    fields: [
      { id: 'nombre', label: 'Nombre', value: m?.nombre, placeholder: 'Ej: Dra. Ana Pérez Soto' },
      { id: 'rut', label: 'RUT', value: m?.rut, placeholder: '12.345.678-9' },
    ],
    onSave: ({ nombre, rut }) => {
      if (!nombre) return 'Escribe el nombre';
      if (rut && !isValidRut(rut)) return 'RUT con dígito verificador inválido';
      const item = makeMedico({ ...m, nombre, rut, updated: Date.now() });
      result = ctx.saveCatalog('medico', item);
      return null;
    },
    onClose: () => done?.(result),
  });
}

function editOperativo(ctx, o = null, done) {
  let result;
  openDialog({
    title: o ? 'Editar operativo' : 'Nuevo operativo',
    fields: [{ id: 'nombre', label: 'Nombre del operativo o ronda', value: o?.nombre, placeholder: 'Ej: Operativo Oftalmología Nov 2026' }],
    onSave: ({ nombre }) => {
      if (!nombre) return 'Escribe el nombre';
      const dup = ctx.operativos.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase() && x.id !== o?.id);
      if (dup) return 'Ya existe un operativo con ese nombre';
      result = ctx.saveCatalog('operativo', makeOperativo({ ...o, nombre, updated: Date.now() }));
      return null;
    },
    onClose: () => done?.(result),
  });
}

/** Opciones de los selectores del formulario según la atención en edición. */
export function renderCatalogSelects(ctx) {
  const f = ctx.rec.f;
  const op = f.operativo || '';
  const opNames = ctx.operativos.map((o) => o.nombre);
  $('#operativoSel').innerHTML =
    '<option value="">Sin operativo</option>' +
    (op && !opNames.includes(op) ? `<option value="${CUR}">${escapeHtml(op)}</option>` : '') +
    opNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
    `<option value="${NEW}">＋ Nuevo operativo…</option>`;
  $('#operativoSel').value = op ? (opNames.includes(op) ? op : CUR) : '';

  const m = findMedico(ctx.medicos, f.medico_nombre, f.medico_rut);
  const hasOther = !m && f.medico_nombre;
  $('#medicoSel').innerHTML =
    '<option value="">Sin médico</option>' +
    (hasOther ? `<option value="${CUR}">${escapeHtml(f.medico_nombre)}</option>` : '') +
    ctx.medicos.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.nombre)}${x.rut ? ' · ' + escapeHtml(x.rut) : ''}</option>`).join('') +
    `<option value="${NEW}">＋ Nuevo médico…</option>`;
  $('#medicoSel').value = m ? m.id : hasOther ? CUR : '';
}

/** Listas de médicos y operativos en Ajustes. */
export function renderCatalogSettings(ctx) {
  const row = (x, sub) => `<div class="it"><div class="t"><b>${escapeHtml(x.nombre)}</b>${sub ? `<span class="muted">${escapeHtml(sub)}</span>` : ''}</div>
    <button type="button" class="ib sm" data-a="edit" data-id="${escapeHtml(x.id)}" title="Editar" aria-label="Editar">${ICON('edit')}</button>
    <button type="button" class="ib sm danger" data-a="del" data-id="${escapeHtml(x.id)}" title="Eliminar" aria-label="Eliminar">${ICON('trash')}</button></div>`;
  $('#medList').innerHTML = ctx.medicos.length ? ctx.medicos.map((m) => row(m, m.rut)).join('') : '<p class="hint">Aún no hay médicos.</p>';
  $('#opList').innerHTML = ctx.operativos.length ? ctx.operativos.map((o) => row(o)).join('') : '<p class="hint">Aún no hay operativos.</p>';
  $('#medCount').textContent = ctx.medicos.length;
  $('#opCount').textContent = ctx.operativos.length;
}
