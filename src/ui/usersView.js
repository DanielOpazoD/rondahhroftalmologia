/**
 * Usuarios (solo administradores; ADR 0014): lista de cuentas, alta por RUT
 * (también desde los perfiles existentes), editar nombre, profesión y rol de
 * administrador, restablecer la clave y desactivar o reactivar.
 *
 * Todo lo sensible se calcula en este PC: el perfil se cifra con la clave del
 * equipo y la clave inicial (RUT sin dígito verificador) nunca viaja.
 */
import { ROLES } from '../config/catalogs.js';
import { accountRut, initialPassword, newUserId, rutBody, INITIAL_PASSWORD_DAYS } from '../core/accounts.js';
import { rolLabel } from '../core/catalog.js';
import { formatRut, fmtDate, normalizeText } from '../core/format.js';
import { importEncKey } from '../sync/crypto.js';
import { createAccountsApi } from '../sync/accountsApi.js';
import { decryptProfile, encryptProfile, credentialsFor } from '../sync/accountCrypto.js';
import { $, toast } from './dom.js';
import { html, setHtml } from './html.js';
import { openDialog } from './dialog.js';
import { uiAlert, uiConfirm } from './modal.js';

const ICON = (n) => html`<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r.key, label: r.label }));
const ADMIN_OPTIONS = [
  { value: 'no', label: 'No' },
  { value: 'si', label: 'Sí: gestiona usuarios y ve el registro de accesos' },
];

/**
 * @typedef {{id: string, rol: string, admin: boolean, estado: string, debeCambiar: boolean, tempExpira: number | null,
 *   creado: number, ultimoIngreso: number | null, bloqueadaHasta: number, nombre: string, rut: string}} UsuarioVista
 */

/** @param {any} ctx contexto de la aplicación */
export function initUsersView(ctx) {
  const api = createAccountsApi();
  /** @type {UsuarioVista[]} */
  let users = [];
  let loading = false;

  const isAdmin = () => Boolean(ctx.accounts?.user?.admin);
  const teamKeyB64 = () => ctx.store.loadSyncConfig()?.encKey || '';
  async function token() {
    const t = ctx.accounts.token() || (await ctx.accounts.ensureToken());
    if (!t) throw new Error('Necesitas conexión para administrar usuarios.');
    return t;
  }

  async function load() {
    if (!isAdmin() || loading) return;
    loading = true;
    $('#usersList').setAttribute('aria-busy', 'true');
    try {
      const { usuarios } = await api.usuarios(await token());
      const key = await importEncKey(teamKeyB64());
      users = await Promise.all(
        usuarios.map(async (u) => {
          const p = await decryptProfile(key, u.id, u.perfil).catch(() => ({ nombre: '(no se pudo leer)', rut: '' }));
          return { ...u, nombre: p.nombre, rut: p.rut };
        }),
      );
      users.sort((a, b) => (a.estado === b.estado ? a.nombre.localeCompare(b.nombre, 'es') : a.estado === 'activo' ? -1 : 1));
      $('#usersErr').textContent = '';
    } catch (e) {
      $('#usersErr').textContent = /** @type {Error} */ (e).message;
    } finally {
      loading = false;
      $('#usersList').removeAttribute('aria-busy');
      render();
    }
  }

  function render() {
    const card = $('#usersCard');
    card.hidden = !isAdmin();
    if (!isAdmin()) return;
    $('#usersCount').textContent = String(users.filter((u) => u.estado === 'activo').length);
    const fromProfiles = profilesWithoutAccount();
    $('#usersFromProfiles').hidden = !fromProfiles.length;
    $('#usersFromProfiles').textContent = `Crear desde perfiles (${fromProfiles.length})`;
    const now = Date.now();
    setHtml(
      $('#usersList'),
      users.length
        ? html`${users.map((u) => {
            const tags = [
              u.admin && html`<span class="tag">Administrador/a</span>`,
              u.estado !== 'activo' && html`<span class="state bad">Desactivada</span>`,
              u.estado === 'activo' &&
                u.debeCambiar &&
                (u.tempExpira && u.tempExpira < now
                  ? html`<span class="state bad">Clave inicial vencida</span>`
                  : html`<span class="state pend">Clave inicial · vence ${fmtDate(new Date(u.tempExpira || now).toISOString().slice(0, 10))}</span>`),
              u.bloqueadaHasta > now && html`<span class="state bad">Bloqueada por intentos</span>`,
            ].filter(Boolean);
            const meta = [
              formatRut(u.rut),
              rolLabel(u.rol),
              u.ultimoIngreso ? `último ingreso ${fmtDate(new Date(u.ultimoIngreso).toISOString().slice(0, 10))}` : 'nunca ha entrado',
            ]
              .filter(Boolean)
              .join(' · ');
            const me = u.id === ctx.accounts.user?.id;
            return html`<div class="prow${u.estado !== 'activo' ? ' off' : ''}">
              <div class="pmain static">
                <span class="pname">${u.nombre}${me ? html` <span class="muted">(tú)</span>` : ''}</span>
                <span class="pmeta">${meta}</span>
                <span class="ptags">${tags}</span>
              </div>
              <div class="pact">
                <button type="button" class="ib sm" data-a="edit" data-id="${u.id}" title="Editar" aria-label="Editar a ${u.nombre}">${ICON('edit')}</button>
                <button type="button" class="ib sm" data-a="reset" data-id="${u.id}" title="Restablecer clave" aria-label="Restablecer la clave de ${u.nombre}">${ICON('lock')}</button>
                <button type="button" class="btn sm" data-a="toggle" data-id="${u.id}">${u.estado === 'activo' ? 'Desactivar' : 'Reactivar'}</button>
              </div>
            </div>`;
          })}`
        : html`<div class="empty">${loading ? 'Cargando…' : 'Sin cuentas cargadas.'}</div>`,
    );
  }

  /** Perfiles (catálogo) con RUT válido que aún no tienen cuenta. */
  function profilesWithoutAccount() {
    const ruts = new Set(users.map((u) => accountRut(u.rut)));
    return ctx.medicos.filter((m) => accountRut(m.rut) && !ruts.has(accountRut(m.rut)));
  }

  /* ---------------------------------------------------------- alta */

  /** @param {{rut?: string, nombre?: string, rol?: string}} [preset] */
  function create(preset = {}) {
    openDialog({
      title: 'Nuevo usuario',
      okLabel: 'Crear',
      fields: [
        { id: 'rut', label: 'RUT', value: preset.rut ? formatRut(preset.rut) : '', placeholder: '12.345.678-9' },
        { id: 'nombre', label: 'Nombre completo', value: preset.nombre || '' },
        { id: 'rol', label: 'Profesión', value: preset.rol || 'medico', options: ROLE_OPTIONS },
        { id: 'admin', label: 'Administrador/a', value: 'no', options: ADMIN_OPTIONS },
      ],
      onSave: ({ rut, nombre, rol, admin }) => {
        if (!accountRut(rut)) return 'RUT inválido (revisa el dígito verificador).';
        if (nombre.length < 3) return 'Escribe el nombre completo.';
        if (users.some((u) => accountRut(u.rut) === accountRut(rut))) return 'Ya existe una cuenta con ese RUT.';
        setTimeout(() => void doCreate({ rut: accountRut(rut), nombre, rol, admin: admin === 'si' }), 0);
        return null;
      },
    });
  }

  /** @param {{rut: string, nombre: string, rol: string, admin: boolean}} p */
  async function doCreate(p) {
    try {
      const t = await token();
      const uid = newUserId();
      const { complemento } = await api.preparar(t, uid);
      const c = await credentialsFor({ password: initialPassword(p.rut), teamKeyB64: teamKeyB64(), uid, complemento });
      const perfil = await encryptProfile(await importEncKey(teamKeyB64()), uid, { nombre: p.nombre, rut: p.rut, rol: p.rol });
      await api.crear(t, {
        id: uid,
        rut: p.rut,
        rol: p.rol,
        admin: p.admin,
        perfil,
        sal: c.sal,
        iter: c.iter,
        acceso: c.acceso,
        envuelta: c.envuelta,
      });
      await load();
      uiAlert({
        title: 'Cuenta creada',
        message: `${p.nombre} entra con su RUT (${formatRut(p.rut)}) y la clave inicial ${rutBody(p.rut)}, que vence en ${INITIAL_PASSWORD_DAYS} días. Al entrar, deberá crear su clave personal.`,
        tone: 'ok',
      });
    } catch (e) {
      uiAlert({ title: 'No se creó la cuenta', message: /** @type {Error} */ (e).message, tone: 'danger' });
    }
  }

  function createFromProfiles() {
    const list = profilesWithoutAccount();
    if (!list.length) return;
    openDialog({
      title: 'Crear desde un perfil',
      okLabel: 'Continuar',
      fields: [
        {
          id: 'perfil',
          label: 'Perfil',
          value: list[0].id,
          options: list.map((m) => ({ value: m.id, label: `${m.nombre} · ${formatRut(m.rut)}` })),
        },
      ],
      onSave: ({ perfil }) => {
        const m = list.find((x) => x.id === perfil);
        if (m) setTimeout(() => create({ rut: m.rut, nombre: m.nombre, rol: m.rol === 'admision' ? 'administrativo' : m.rol }), 0);
        return null;
      },
    });
  }

  /* -------------------------------------------------------- editar */

  /** @param {UsuarioVista} u */
  function edit(u) {
    openDialog({
      title: `Editar a ${u.nombre}`,
      fields: [
        { id: 'nombre', label: 'Nombre completo', value: u.nombre },
        { id: 'rol', label: 'Profesión', value: u.rol, options: ROLE_OPTIONS },
        { id: 'admin', label: 'Administrador/a', value: u.admin ? 'si' : 'no', options: ADMIN_OPTIONS },
      ],
      onSave: ({ nombre, rol, admin }) => {
        if (nombre.length < 3) return 'Escribe el nombre completo.';
        setTimeout(async () => {
          try {
            const perfil = await encryptProfile(await importEncKey(teamKeyB64()), u.id, { nombre, rut: u.rut, rol });
            await api.editar(await token(), { id: u.id, rol, admin: admin === 'si', perfil });
            await load();
            toast('Usuario actualizado');
          } catch (e) {
            uiAlert({ title: 'No se guardaron los cambios', message: /** @type {Error} */ (e).message, tone: 'danger' });
          }
        }, 0);
        return null;
      },
    });
  }

  /** @param {UsuarioVista} u */
  async function reset(u) {
    const ok = await uiConfirm({
      title: 'Restablecer clave',
      message: `La clave de ${u.nombre} volverá a ser la inicial: su RUT sin dígito verificador (${rutBody(u.rut)}), válida por ${INITIAL_PASSWORD_DAYS} días. Sus sesiones abiertas se cierran y al entrar deberá crear una clave nueva.`,
      tone: 'warn',
      okLabel: 'Restablecer',
    });
    if (!ok) return;
    try {
      const t = await token();
      const { complemento } = await api.preparar(t, u.id, true);
      const c = await credentialsFor({ password: initialPassword(u.rut), teamKeyB64: teamKeyB64(), uid: u.id, complemento });
      await api.restablecer(t, { id: u.id, sal: c.sal, iter: c.iter, acceso: c.acceso, envuelta: c.envuelta });
      await load();
      toast(`Clave de ${u.nombre} restablecida`);
    } catch (e) {
      uiAlert({ title: 'No se restableció la clave', message: /** @type {Error} */ (e).message, tone: 'danger' });
    }
  }

  /** @param {UsuarioVista} u */
  async function toggle(u) {
    const off = u.estado === 'activo';
    if (off) {
      const ok = await uiConfirm({
        title: 'Desactivar cuenta',
        message: `${u.nombre} no podrá entrar ni sincronizar, y sus sesiones abiertas se cierran. Lo que registró se conserva. Puedes reactivarla después.`,
        tone: 'danger',
        okLabel: 'Desactivar',
      });
      if (!ok) return;
    }
    try {
      await api.editar(await token(), { id: u.id, estado: off ? 'desactivado' : 'activo' });
      await load();
      toast(off ? 'Cuenta desactivada' : 'Cuenta reactivada');
    } catch (e) {
      uiAlert({ title: 'No se pudo cambiar', message: /** @type {Error} */ (e).message, tone: 'danger' });
    }
  }

  /** Cuentas con nombre (también para el registro de accesos). */
  ctx.loadAccountUsers = async () => {
    await load();
    return users;
  };

  $('#usersAdd').addEventListener('click', () => create());
  $('#usersFromProfiles').addEventListener('click', createFromProfiles);
  $('#usersReload').addEventListener('click', () => void load());
  $('#usersSearch').addEventListener('input', () => {
    const q = normalizeText($('#usersSearch').value);
    for (const row of /** @type {HTMLElement[]} */ ([...$('#usersList').querySelectorAll('.prow')])) {
      row.hidden = Boolean(q) && !normalizeText(row.textContent).includes(q);
    }
  });
  $('#usersList').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button[data-a]');
    const u = b && users.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.id);
    if (!u) return;
    const a = /** @type {HTMLElement} */ (b).dataset.a;
    if (a === 'edit') edit(u);
    if (a === 'reset') void reset(u);
    if (a === 'toggle') void toggle(u);
  });
  ctx.on('cuenta', () => {
    render();
    void load();
  });
  // Al abrir Ajustes, la lista se actualiza.
  ctx.on('tab:t-aj', () => void load());
  render();
}
