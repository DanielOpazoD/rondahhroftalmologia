/**
 * Pestaña Ajustes: lista de procedimientos, opciones de PDF/nota, respaldo y zona de cuidado.
 */
import { DEFAULT_PROCS } from '../specialties/activa/config.js';
import { todayIso } from '../core/format.js';
import { buildBackup, parseBackup, mergeBackup, packBackup, unpackBackup, attachmentsToImport } from '../core/backup.js';
import { fmtSize } from '../core/attachments.js';
import { createSecret } from '../core/pseudonym.js';
import { $, download, toast } from './dom.js';
import { uiAlert, uiConfirm } from './modal.js';
import { html, setHtml } from './html.js';

/** @param {import('./context.js').AppContext} ctx */
export function initSettingsView(ctx) {
  $('#ajList').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'ajReset') {
      if (
        await uiConfirm({
          title: 'Restaurar lista',
          message: '¿Volver a la lista original de procedimientos? Las atenciones guardadas no cambian.',
          okLabel: 'Restaurar',
        })
      ) {
        ctx.setProcs(structuredClone(DEFAULT_PROCS));
      }
      return;
    }
    const i = Number(b.dataset.i);
    const procs = [...ctx.procs];
    if (b.dataset.a === 'rm') {
      if (
        !(await uiConfirm({
          title: 'Quitar procedimiento',
          message: `«${procs[i].n}» se quitará de la lista. Las atenciones ya guardadas lo conservan.`,
          tone: 'danger',
          okLabel: 'Quitar',
        }))
      ) {
        return;
      }
      procs.splice(i, 1);
    } else if (b.dataset.a === 'up' && i > 0) {
      [procs[i - 1], procs[i]] = [procs[i], procs[i - 1]];
    } else if (b.dataset.a === 'pio') {
      procs[i] = { ...procs[i], pio: procs[i].pio ? 0 : 1 };
    }
    ctx.setProcs(procs);
  });
  $('#ajAdd').addEventListener('click', () => {
    const n = $('#ajNew').value.trim();
    if (!n) return;
    if (ctx.procs.some((p) => p.n.toLowerCase() === n.toLowerCase())) {
      toast('Ese procedimiento ya está en la lista');
      return;
    }
    ctx.setProcs([...ctx.procs, { id: 'c_' + Date.now().toString(36), n, pio: $('#ajPio').checked ? 1 : 0 }]);
    $('#ajNew').value = '';
    $('#ajPio').checked = false;
  });

  const saveSettings = () => {
    ctx.settings = {
      ...ctx.settings,
      pdfFlatten: $('#setFlatten').checked,
      pdfFooter: $('#setFooter').checked,
      notaPie: $('#setPie').value,
      deviceName: $('#setDevice').value.trim(),
    };
    ctx.store.saveSettings(ctx.settings);
  };
  ['#setFlatten', '#setFooter'].forEach((s) => $(s).addEventListener('change', saveSettings));
  ['#setPie', '#setDevice'].forEach((s) => $(s).addEventListener('change', saveSettings));

  $('#bkExp').addEventListener('click', async () => {
    const { store } = ctx;
    const attachments = store.supportsAttachments() ? store.loadAttachments() : [];
    const data = buildBackup({
      records: ctx.records,
      futureRecords: store.loadFutureRecords(),
      procs: ctx.procs,
      anonSecret: store.loadSecret(),
      practica: ctx.practice,
      auditDocs: store.loadAuditDocs(),
      patients: store.loadPatients(),
      attachments,
    });
    // Con adjuntos, un ZIP con su contenido; sin adjuntos, el JSON de siempre.
    /** @type {Map<string, Uint8Array>} */
    const contents = new Map();
    if (attachments.length) {
      const have = new Set(await store.attachmentDataIds());
      for (const a of attachments) {
        const d = have.has(a.id) ? await store.loadAttachmentData(a.id) : undefined;
        if (d) contents.set(a.id, d.bytes);
      }
    }
    if (contents.size) {
      const zip = packBackup(data, contents);
      download(
        new Blob([/** @type {BlobPart} */ (zip)], { type: 'application/zip' }),
        `respaldo_oftalmo_${todayIso()}.zip`,
        'application/zip',
      );
      toast(`Respaldo descargado (con ${contents.size} adjunto(s), ${fmtSize(zip.length)})`);
    } else {
      download(JSON.stringify(data), `respaldo_oftalmo_${todayIso()}.json`, 'application/json');
      toast('Respaldo descargado');
    }
    ctx.persist(() => store.saveLastBackup(Date.now()));
  });
  $('#bkImpBtn').addEventListener('click', () => $('#bkImp').click());
  $('#bkImp').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { text, contents } = unpackBackup(new Uint8Array(await file.arrayBuffer()));
      const incoming = parseBackup(text);
      // Los datos de ejemplo nunca entran a los datos reales (ni al revés).
      if (incoming.practica !== Boolean(ctx.practice)) {
        throw new Error(
          incoming.practica
            ? 'Es un respaldo del modo práctica (datos de ejemplo): no se importa a los datos reales.'
            : 'En el modo práctica solo se importan respaldos del modo práctica.',
        );
      }
      const localData = {
        records: ctx.records,
        futureRecords: ctx.store.loadFutureRecords(),
        procs: ctx.procs,
        auditDocs: ctx.store.loadAuditDocs(),
        patients: ctx.store.loadPatients(),
      };
      let merged = mergeBackup(localData, incoming);
      if (merged.futureConflicts.length) {
        const replace = await uiConfirm({
          title: 'Atenciones de una versión más nueva',
          message: `El respaldo trae ${merged.futureConflicts.length} atención(es) de una versión más nueva de la app que reemplazarían atenciones existentes en este equipo. Si no reconoces este archivo, no las reemplaces.`,
          tone: 'warn',
          okLabel: 'Reemplazar',
          cancelLabel: 'Mantener las actuales',
        });
        if (replace) merged = mergeBackup(localData, incoming, { allowFutureOverride: true });
      }
      ctx.store.saveRecords([...merged.records, ...merged.futureRecords]);
      ctx.store.saveAuditDocs(merged.auditDocs);
      ctx.store.savePatients(merged.patients);
      ctx.store.saveProcs(merged.procs);
      // Adjuntos: primero el contenido (verificado), luego sus metadatos.
      let attMsg = '';
      if (incoming.attachments?.length && ctx.store.supportsAttachments()) {
        const att = await attachmentsToImport(incoming.attachments, contents, (id) => Boolean(ctx.store.getAttachment(id)));
        for (const [id, bytes] of att.contents) await ctx.store.saveAttachmentData(id, bytes);
        ctx.store.saveAttachments(att.metas);
        if (att.metas.length) attMsg = `\n\n${att.metas.length} adjunto(s) nuevo(s).`;
        if (att.rechazados.length) attMsg += ` No se importó el contenido dañado de: ${att.rechazados.join(', ')}.`;
      }
      let keyMsg = '';
      const local = ctx.store.loadSecret();
      if (incoming.anonSecret && !local) {
        ctx.store.saveSecret(incoming.anonSecret);
        keyMsg = '\n\nSe adoptó la clave de seudonimización del respaldo.';
      } else if (incoming.anonSecret && local && incoming.anonSecret !== local) {
        keyMsg = '\n\nOjo: el respaldo trae otra clave de seudonimización; se mantiene la de este equipo.';
      }
      ctx.reload();
      ctx.sync?.schedule();
      uiAlert({
        title: 'Respaldo importado',
        message: `${merged.added} nuevas, ${merged.updated} actualizadas y ${merged.unchanged} sin cambios.${attMsg}${keyMsg}`,
        tone: 'ok',
      });
    } catch (err) {
      uiAlert({ title: 'No se pudo importar', message: err.message, tone: 'danger' });
    }
  });

  $('#anRegen').addEventListener('click', async () => {
    const ok = await uiConfirm({
      title: 'Nueva clave de seudonimización',
      message:
        'Con una clave nueva, los mismos pacientes tendrán códigos distintos en las próximas exportaciones, y las anteriores ya no coincidirán.',
      tone: 'warn',
      okLabel: 'Generar clave nueva',
    });
    if (!ok) return;
    ctx.store.saveSecret(createSecret());
    ctx.reload();
    toast('Nueva clave generada');
  });
  $('#wipe').addEventListener('click', async () => {
    const n = ctx.records.length;
    if (!n) return toast('No hay atenciones que borrar');
    const syncNote = ctx.sync?.enabled
      ? '\n\nSolo se borran en ESTE equipo: con la sincronización activa, las atenciones de los demás equipos se volverán a descargar.'
      : '';
    const ok = await uiConfirm({
      title: 'Borrar atenciones de este equipo',
      message: `Se borrarán las ${n} atenciones guardadas en este equipo. Descarga un respaldo antes.${syncNote}`,
      tone: 'danger',
      okLabel: `Borrar ${n} atenciones`,
    });
    if (ok) {
      ctx.store.saveRecords([]);
      ctx.reload();
    }
  });
}

export function renderSettings(ctx) {
  const procRows = ctx.procs.map(
    (p, i) => html`<div class="it"><div class="t"><b>${p.n}</b></div>
        <button type="button" class="chip mini${p.pio ? ' on' : ''}" data-a="pio" data-i="${i}" aria-pressed="${String(!!p.pio)}" title="Pide PIO por ojo">PIO</button>
        <button type="button" class="ib sm" data-a="up" data-i="${i}" title="Subir" aria-label="Subir"${i ? '' : html` disabled`}><svg aria-hidden="true"><use href="#i-up"/></svg></button>
        <button type="button" class="ib sm danger" data-a="rm" data-i="${i}" title="Quitar" aria-label="Quitar"><svg aria-hidden="true"><use href="#i-trash"/></svg></button></div>`,
  );
  setHtml(
    $('#ajList'),
    html`${procRows}<div class="it"><div class="t"></div><button type="button" class="btn sm" id="ajReset">Restaurar lista original</button></div>`,
  );
  $('#setFlatten').checked = !!ctx.settings.pdfFlatten;
  $('#setFooter').checked = !!ctx.settings.pdfFooter;
  $('#setPie').value = ctx.settings.notaPie || '';
  $('#setDevice').value = ctx.settings.deviceName || '';
}
