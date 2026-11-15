/**
 * Pestaña Ajustes: lista de procedimientos, opciones de PDF/nota, respaldo y zona de cuidado.
 */
import { DEFAULT_PROCS } from '../config/catalogs.js';
import { escapeHtml, todayIso } from '../core/format.js';
import { buildBackup, parseBackup, mergeBackup } from '../core/backup.js';
import { createSecret } from '../core/anonymize.js';
import { $, download, toast } from './dom.js';

/** @param {import('./context.js').AppContext} ctx */
export function initSettingsView(ctx) {
  $('#ajList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'ajReset') {
      if (confirm('¿Volver a la lista original de procedimientos?')) ctx.setProcs(structuredClone(DEFAULT_PROCS));
      return;
    }
    const i = Number(b.dataset.i);
    const procs = [...ctx.procs];
    if (b.dataset.a === 'rm') {
      if (!confirm(`¿Quitar «${procs[i].n}» de la lista? Las atenciones ya guardadas lo conservan.`)) return;
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
    ctx.settings = { ...ctx.settings, pdfFlatten: $('#setFlatten').checked, pdfFooter: $('#setFooter').checked, notaPie: $('#setPie').value };
    ctx.store.saveSettings(ctx.settings);
  };
  ['#setFlatten', '#setFooter'].forEach((s) => $(s).addEventListener('change', saveSettings));
  $('#setPie').addEventListener('change', saveSettings);

  $('#bkExp').addEventListener('click', () => {
    const data = buildBackup({ records: ctx.records, procs: ctx.procs, anonSecret: ctx.store.loadSecret() });
    download(JSON.stringify(data), `respaldo_oftalmo_${todayIso()}.json`, 'application/json');
    toast('Respaldo descargado');
  });
  $('#bkImpBtn').addEventListener('click', () => $('#bkImp').click());
  $('#bkImp').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = parseBackup(await file.text());
      const merged = mergeBackup({ records: ctx.records, procs: ctx.procs }, incoming);
      ctx.store.saveRecords(merged.records);
      ctx.store.saveProcs(merged.procs);
      let keyMsg = '';
      const local = ctx.store.loadSecret();
      if (incoming.anonSecret && !local) {
        ctx.store.saveSecret(incoming.anonSecret);
        keyMsg = '\nSe adoptó la clave de seudonimización del respaldo.';
      } else if (incoming.anonSecret && local && incoming.anonSecret !== local) {
        keyMsg = '\nOjo: el respaldo trae otra clave de seudonimización; se mantiene la de este equipo.';
      }
      ctx.reload();
      ctx.sync?.schedule();
      alert(`Importado: ${merged.added} nuevas, ${merged.updated} actualizadas, ${merged.unchanged} sin cambios.${keyMsg}`);
    } catch (err) {
      alert('No se pudo importar: ' + err.message);
    }
  });

  $('#anRegen').addEventListener('click', () => {
    if (!confirm('Con una clave nueva, los mismos pacientes tendrán códigos distintos en las próximas exportaciones seudonimizadas y las anteriores ya no coincidirán. ¿Continuar?')) return;
    ctx.store.saveSecret(createSecret());
    ctx.reload();
    toast('Nueva clave generada');
  });
  $('#wipe').addEventListener('click', () => {
    const n = ctx.records.length;
    if (!n) return toast('No hay atenciones que borrar');
    const syncNote = ctx.sync?.enabled ? '\n\nSolo se borran en ESTE equipo: con la sincronización activa, las atenciones de los demás equipos se volverán a descargar.' : '';
    if (confirm('¿Borrar TODAS las atenciones guardadas en este equipo? Descarga un respaldo antes.' + syncNote) && confirm(`Confirma de nuevo: se borrarán ${n} atenciones.`)) {
      ctx.store.saveRecords([]);
      ctx.reload();
    }
  });
}

export function renderSettings(ctx) {
  $('#ajList').innerHTML =
    ctx.procs
      .map(
        (p, i) => `<div class="it"><div class="t"><b>${escapeHtml(p.n)}</b></div>
        <button type="button" class="chip mini${p.pio ? ' on' : ''}" data-a="pio" data-i="${i}" aria-pressed="${!!p.pio}" title="Pide PIO por ojo">PIO</button>
        <button type="button" class="ib sm" data-a="up" data-i="${i}" title="Subir" aria-label="Subir"${i ? '' : ' disabled'}><svg><use href="#i-up"/></svg></button>
        <button type="button" class="ib sm danger" data-a="rm" data-i="${i}" title="Quitar" aria-label="Quitar"><svg><use href="#i-trash"/></svg></button></div>`,
      )
      .join('') + '<div class="it"><div class="t"></div><button type="button" class="btn sm" id="ajReset">Restaurar lista original</button></div>';
  $('#setFlatten').checked = !!ctx.settings.pdfFlatten;
  $('#setFooter').checked = !!ctx.settings.pdfFooter;
  $('#setPie').value = ctx.settings.notaPie || '';
}
