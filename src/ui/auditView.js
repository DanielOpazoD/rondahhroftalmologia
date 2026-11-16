/**
 * Registro de accesos (solo administradores; ADR 0014): sesiones con su
 * duración y eventos (qué fichas y atenciones se abrieron, qué se descargó y
 * qué se guardó), con filtros y descarga a Excel.
 *
 * El servidor guarda ids: los nombres de pacientes se resuelven con los datos
 * de este PC y los de las personas, con las cuentas (perfiles cifrados).
 */
import { eventRows, sessionRows, fmtDuration, GROUPS } from '../core/accessLog.js';
import { fmtDate, fmtDateTime, todayIso, normalizeText } from '../core/format.js';
import { patientLabel } from '../core/patient.js';
import { buildXlsx } from '../lib/xlsx.js';
import { createAccountsApi } from '../sync/accountsApi.js';
import { ESPECIALIDAD } from '../config/catalogs.js';
import { $, download, toast, withBusy } from './dom.js';
import { html, setHtml } from './html.js';

const MAX_ROWS = 500;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** @param {any} ctx contexto de la aplicación */
export function initAuditView(ctx) {
  const api = createAccountsApi();
  /** @type {{eventos: any[], sesiones: any[]} | null} */
  let data = null;
  /** @type {Map<string, string>} */
  let names = new Map();
  const isAdmin = () => Boolean(ctx.accounts?.user?.admin);

  /** @param {string | undefined} uid */
  const userName = (uid) => (uid ? names.get(uid) || `Cuenta ${uid.slice(1, 7)}` : '');

  /** Qué se tocó, en palabras (con los datos de este PC). @param {any} e */
  function objectLabel(e) {
    const id = e.obj;
    if (e.ev.startsWith('atencion.')) {
      const r = ctx.records.find((/** @type {any} */ x) => x.id === id);
      return r
        ? `${r.f.paciente_nombre || r.f.paciente_rut || 'Sin nombre'} · ${fmtDate(r.f.fecha_atencion) || 'sin fecha'}`
        : `atención ${id} (no está en este PC)`;
    }
    if (e.ev === 'ficha.ver') {
      const p = ctx.store.getPatient(id);
      return p ? patientLabel(p) : `ficha ${id} (no está en este PC)`;
    }
    if (e.ev === 'adjunto.ver') {
      const a = ctx.store.getAttachment(id);
      const r = a && ctx.records.find((/** @type {any} */ x) => x.id === a.atencionId);
      return a ? `${a.nombre}${r ? ` · ${r.f.paciente_nombre || r.f.paciente_rut}` : ''}` : `adjunto ${id}`;
    }
    if (e.ev.startsWith('usuario.') || e.ev === 'cuentas.activar') {
      const det = e.det?.estado
        ? ` (${e.det.estado})`
        : Array.isArray(e.det?.campos) && e.det.campos.length
          ? ` (${e.det.campos.join(', ')})`
          : '';
      return userName(id) + det;
    }
    if (e.ev === 'sync.escribir') {
      return e.esp === 'pacientes'
        ? 'fichas de pacientes'
        : e.esp?.endsWith('-adjuntos')
          ? 'contenido de adjuntos'
          : `atenciones de ${ESPECIALIDAD.nombre}`;
    }
    if (e.ev === 'sesion.fin' && e.det?.motivo) return String(e.det.motivo);
    if (e.n !== undefined) return `${e.n} ${e.n === 1 ? 'atención' : 'atenciones'}`;
    return '';
  }

  function rows() {
    if (!data) return { ev: [], ses: [] };
    const uid = $('#audUser').value;
    const q = normalizeText($('#audQuery').value);
    const ev = eventRows(data.eventos, {
      userName,
      objectLabel,
      group: $('#audGroup').value,
      uid,
      query: q ? (t) => normalizeText(t).includes(q) : undefined,
    });
    const ses = $('#audGroup').value && $('#audGroup').value !== 'sesiones' ? [] : sessionRows(data.sesiones, { userName, uid });
    return { ev, ses };
  }

  function render() {
    $('#auditCard').hidden = !isAdmin();
    $('#audFilters').hidden = !data;
    if (!isAdmin() || !data) return setHtml($('#audResult'), html``);
    const { ev, ses } = rows();
    const sesTable = ses.length
      ? html`<h3 class="audh">Sesiones (${ses.length})</h3>
          <div class="tw"><table class="st aud"><tr><th>Persona</th><th>Inicio</th><th>Hasta</th><th>Duración</th><th>Cómo terminó</th></tr>
          ${ses
            .slice(0, MAX_ROWS)
            .map(
              (s) =>
                html`<tr><td>${s.persona}</td><td>${fmtDateTime(new Date(s.inicio))}</td><td>${fmtDateTime(new Date(s.fin))}</td><td>${fmtDuration(s.duracionMin)}</td><td>${s.estado}</td></tr>`,
            )}</table></div>`
      : '';
    const evTable = ev.length
      ? html`<h3 class="audh">Eventos (${ev.length})</h3>
          <div class="tw"><table class="st aud"><tr><th>Fecha y hora</th><th>Persona</th><th>Acción</th><th>Detalle</th></tr>
          ${ev
            .slice(0, MAX_ROWS)
            .map(
              (r) =>
                html`<tr><td>${fmtDateTime(new Date(r.t))}</td><td>${r.persona}</td><td>${r.accion}</td><td>${r.detalle}${r.origen ? html` <span class="muted">· ${r.origen}</span>` : ''}</td></tr>`,
            )}</table></div>
          ${ev.length > MAX_ROWS ? html`<p class="hint">Se muestran ${MAX_ROWS} de ${ev.length}: usa los filtros o descarga el Excel.</p>` : ''}`
      : html`<div class="empty">Sin eventos con estos filtros.</div>`;
    setHtml($('#audResult'), html`${sesTable}${evTable}`);
  }

  async function load(button) {
    const desde = $('#audDesde').value;
    const hasta = $('#audHasta').value;
    if (!desde || !hasta || hasta < desde) return void ($('#audErr').textContent = 'Revisa las fechas.');
    if ((Date.parse(hasta) - Date.parse(desde)) / 86_400_000 > 62) {
      return void ($('#audErr').textContent = 'Elige un rango de hasta 62 días.');
    }
    await withBusy(button, async () => {
      try {
        const t = ctx.accounts.token() || (await ctx.accounts.ensureToken());
        if (!t) throw new Error('Necesitas conexión para consultar el registro.');
        // Días LOCALES completos (desde las 00:00 del primero hasta las 23:59 del último).
        const from = new Date(`${desde}T00:00:00`).getTime();
        const to = new Date(`${hasta}T23:59:59.999`).getTime();
        const [res, users] = await Promise.all([api.auditoria(t, from, to), ctx.loadAccountUsers()]);
        names = new Map(users.map((/** @type {any} */ u) => [u.id, u.nombre]));
        data = res;
        setHtml(
          $('#audUser'),
          html`<option value="">Todas las personas</option>${users.map((/** @type {any} */ u) => html`<option value="${u.id}">${u.nombre}</option>`)}`,
        );
        $('#audErr').textContent = '';
      } catch (e) {
        $('#audErr').textContent = /** @type {Error} */ (e).message;
      }
    });
    render();
  }

  function exportXlsx() {
    const { ev, ses } = rows();
    const bytes = buildXlsx(
      [
        {
          name: 'Eventos',
          header: true,
          rows: [
            ['Fecha y hora', 'Persona', 'Acción', 'Detalle', 'Origen'],
            ...ev.map((r) => [fmtDateTime(new Date(r.t)), r.persona, r.accion, r.detalle, r.origen]),
          ],
        },
        {
          name: 'Sesiones',
          header: true,
          rows: [
            ['Persona', 'Inicio', 'Hasta', 'Duración (min)', 'Cómo terminó'],
            ...ses.map((s) => [s.persona, fmtDateTime(new Date(s.inicio)), fmtDateTime(new Date(s.fin)), s.duracionMin, s.estado]),
          ],
        },
      ],
      { title: 'Registro de accesos', creator: 'Hospital Hanga Roa' },
    );
    download(bytes, `registro_accesos_${$('#audDesde').value}_a_${$('#audHasta').value}.xlsx`, XLSX_MIME);
    toast('Registro descargado');
  }

  const today = todayIso();
  $('#audHasta').value = today;
  $('#audDesde').value = todayIso(new Date(Date.now() - 6 * 86_400_000));
  setHtml($('#audGroup'), html`${GROUPS.map((g) => html`<option value="${g.key}">${g.label}</option>`)}`);
  $('#audLoad').addEventListener('click', (e) => void load(e.currentTarget));
  for (const id of ['#audUser', '#audGroup']) $(id).addEventListener('change', render);
  $('#audQuery').addEventListener('input', render);
  $('#audXlsx').addEventListener('click', exportXlsx);
  ctx.on('cuenta', render);
  render();
}
