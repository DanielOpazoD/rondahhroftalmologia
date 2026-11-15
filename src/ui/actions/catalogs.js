/**
 * Catálogos compartidos: procedimientos, perfiles y operativos.
 */
import { clock } from '../../core/clock.js';
import { seedCatalogs, upsert, byName } from '../../core/catalog.js';
import { syncAttentionView, renderProcList } from '../attentionView.js';
import { renderSettings } from '../settingsView.js';
import { renderCatalogSelects, renderCatalogSettings } from '../catalogView.js';
import { renderUserChip } from '../userView.js';

/**
 * @param {any} ctx contexto de la aplicación (ver ui/context.js)
 * @param {ReturnType<import('../../storage/store.js').createStore>} store
 */
export function catalogActions(ctx, store) {
  return {
    setProcs(procs) {
      if (!ctx.persist(() => store.saveProcs(procs))) return;
      ctx.procs = procs;
      renderProcList(ctx);
      renderSettings(ctx);
      syncAttentionView(ctx);
    },

    /** Completa los catálogos con médicos y operativos de atenciones antiguas (una vez por equipo). */
    seedCatalogs() {
      const r = seedCatalogs({ records: ctx.records, recordado: store.loadMedico(), medicos: ctx.medicos, operativos: ctx.operativos });
      if (!r.added) return;
      ctx.persist(() => {
        store.saveMedicos(r.medicos);
        store.saveOperativos(r.operativos);
      });
      ctx.medicos = r.medicos;
      ctx.operativos = r.operativos;
    },

    reloadCatalogs() {
      ctx.medicos = store.loadMedicos();
      ctx.operativos = store.loadOperativos();
      renderCatalogSelects(ctx);
      renderCatalogSettings(ctx);
      renderUserChip(ctx);
    },

    /** Crea o actualiza un médico u operativo y lo comparte. Devuelve el elemento guardado. */
    saveCatalog(kind, item) {
      const key = kind === 'medico' ? 'medicos' : 'operativos';
      const list = byName(upsert(ctx[key], item));
      const ok = ctx.persist(() => {
        if (kind === 'medico') store.saveMedicos(list);
        else store.saveOperativos(list);
        const t = store.loadTombstones();
        if (t[item.id]) {
          delete t[item.id];
          store.saveTombstones(t);
        }
      });
      if (!ok) return undefined;
      ctx.reloadCatalogs();
      ctx.sync?.schedule();
      return item;
    },

    deleteCatalog(kind, id) {
      const key = kind === 'medico' ? 'medicos' : 'operativos';
      const item = ctx[key].find((x) => x.id === id);
      const list = ctx[key].filter((x) => x.id !== id);
      ctx.persist(() => {
        if (kind === 'medico') store.saveMedicos(list);
        else store.saveOperativos(list);
        store.addTombstone(id, Math.max(clock.tick(), (item?.updated || 0) + 1));
      });
      ctx.reloadCatalogs();
      ctx.sync?.schedule();
    },
  };
}
