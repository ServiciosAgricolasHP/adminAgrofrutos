import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  faenasService,
  subfaenasService,
  cyclesService,
  workdaysService,
} from "../services";
import {
  userPrefsService,
  FAENA_PALETTE,
  UNGROUPED_ID,
  defaultLayout,
  normalizeLayout,
} from "../services/userPrefsService";
import { useAuth } from "../contexts/AuthContext";
import Modal from "../components/Modal";
import ConfirmDialog from "../components/ConfirmDialog";
import TextField from "../components/TextField";
import Select from "../components/Select";
import { useIsMobile } from "../hooks/useIsMobile";
import { workdayDocId } from "../utils/cosechaCombos";

const emptyFaena = { name: "", location: "", notes: "" };
const emptySub = { name: "", notes: "" };

const orderKey = (uid) => `af.faenaOrder.${uid || "anon"}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const newId = () => (crypto?.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);

function applyOrder(items, order) {
  if (!order?.length) return items;
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ai = idx.has(a.id) ? idx.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = idx.has(b.id) ? idx.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

function defaultLabors(workers = []) {
  return [{ id: newId(), name: "Principal", type: "main", workers }];
}

export default function Faenas() {
  const isMobile = useIsMobile();
  const { user, isAdmin } = useAuth();
  const storageKey = orderKey(user?.uid);
  const [searchParams, setSearchParams] = useSearchParams();

  const [rawFaenas, setRawFaenas] = useState([]);
  const [order, setOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [subsByFaena, setSubsByFaena] = useState({});
  const [cyclesByFaena, setCyclesByFaena] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(() => searchParams.get("selected"));

  // Sync selectedId with URL param (for breadcrumb deep-links from CycleDetail)
  useEffect(() => {
    const fromUrl = searchParams.get("selected");
    if (fromUrl && fromUrl !== selectedId) setSelectedId(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (selectedId) {
      if (searchParams.get("selected") !== selectedId) {
        setSearchParams({ selected: selectedId }, { replace: true });
      }
    } else if (searchParams.get("selected")) {
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const [faenaForm, setFaenaForm] = useState(null);
  const [subForm, setSubForm] = useState(null);
  const [cycleForm, setCycleForm] = useState(null);
  const [closeFlow, setCloseFlow] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const [dragId, setDragId] = useState(null);
  const [dropOverId, setDropOverId] = useState(null);
  const [dropOverGroupId, setDropOverGroupId] = useState(null);

  // ---------------- Layout (groups + colors per user) ----------------
  const [layout, setLayout] = useState(defaultLayout);
  const [editLayout, setEditLayout] = useState(false);
  const layoutSaveTimer = useRef(null);

  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      const saved = await userPrefsService.getLayout(user.uid);
      setLayout(normalizeLayout(saved));
    })();
  }, [user?.uid]);

  // Debounced persist
  const persistLayout = (next) => {
    setLayout(next);
    if (!user?.uid) return;
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      userPrefsService.saveLayout(user.uid, next).catch((err) => console.error("[layout] save:", err));
    }, 400);
  };

  const faenas = useMemo(() => applyOrder(rawFaenas, order), [rawFaenas, order]);

  // Faenas indexed by group
  const faenasByGroup = useMemo(() => {
    const out = {};
    for (const g of layout.groups) out[g.id] = [];
    for (const f of faenas) {
      const gid = layout.faenaGroup[f.id] && out[layout.faenaGroup[f.id]] ? layout.faenaGroup[f.id] : UNGROUPED_ID;
      out[gid].push(f);
    }
    return out;
  }, [faenas, layout]);

  const persistOrder = (next) => {
    setOrder(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch (e) { void e; }
  };

  const loadFaenas = async () => {
    setLoading(true);
    try {
      const list = await faenasService.list({
        order: ["name", "asc"],
        cache: true,
        persist: true,
        ttl: 10 * 60 * 1000,
      });
      setRawFaenas(list);
      const ids = list.map((f) => f.id);
      const cleaned = order.filter((id) => ids.includes(id));
      const missing = ids.filter((id) => !cleaned.includes(id));
      const next = [...cleaned, ...missing];
      if (JSON.stringify(next) !== JSON.stringify(order)) persistOrder(next);
    } finally {
      setLoading(false);
    }
  };

  const loadSubs = async (faenaId) => {
    const list = await subfaenasService.list({
      wheres: [["faenaId", "==", faenaId]],
      order: ["name", "asc"],
      cache: true,
      persist: true,
      ttl: 10 * 60 * 1000,
    });
    setSubsByFaena((prev) => ({ ...prev, [faenaId]: list }));
  };

  const loadCycles = async (faenaId) => {
    const list = await cyclesService.list({
      wheres: [["faenaId", "==", faenaId]],
      order: ["createdAt", "desc"],
      cache: true,
      ttl: 2 * 60 * 1000,
    });
    setCyclesByFaena((prev) => ({ ...prev, [faenaId]: list }));
  };

  useEffect(() => {
    loadFaenas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    if (!subsByFaena[selectedId]) loadSubs(selectedId);
    if (!cyclesByFaena[selectedId]) loadCycles(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const onDragStart = (id) => () => setDragId(id);
  const onDragOver = (id) => (e) => {
    e.preventDefault();
    if (id !== dropOverId) setDropOverId(id);
  };
  const onDragLeave = () => setDropOverId(null);
  const onDrop = (targetId) => (e) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDropOverId(null);
      return;
    }
    // Move drag's group to target's group if different
    const targetGroup = layout.faenaGroup[targetId] || UNGROUPED_ID;
    const dragGroup = layout.faenaGroup[dragId] || UNGROUPED_ID;
    if (targetGroup !== dragGroup) {
      persistLayout({
        ...layout,
        faenaGroup: { ...layout.faenaGroup, [dragId]: targetGroup },
      });
    }
    const ids = faenas.map((f) => f.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId);
    persistOrder(next);
    setDragId(null);
    setDropOverId(null);
  };
  const onDragEnd = () => {
    setDragId(null);
    setDropOverId(null);
    setDropOverGroupId(null);
  };

  // Drop on group section (empty area or header) → assign drag's faena to that group
  const onGroupDragOver = (gid) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (gid !== dropOverGroupId) setDropOverGroupId(gid);
  };
  const onGroupDrop = (gid) => (e) => {
    e.preventDefault();
    if (!dragId) return;
    const currentGroup = layout.faenaGroup[dragId] || UNGROUPED_ID;
    if (currentGroup !== gid) {
      persistLayout({
        ...layout,
        faenaGroup: { ...layout.faenaGroup, [dragId]: gid },
      });
    }
    setDragId(null);
    setDropOverId(null);
    setDropOverGroupId(null);
  };

  // ---------------- Group management ----------------
  const newGroupId = () => `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const addGroup = () => {
    const id = newGroupId();
    const newGroup = { id, name: "Nuevo grupo", color: null };
    // Insert before ungrouped (which is always last)
    const groups = [...layout.groups];
    const ungroupedIdx = groups.findIndex((g) => g.id === UNGROUPED_ID);
    groups.splice(ungroupedIdx, 0, newGroup);
    persistLayout({ ...layout, groups });
  };

  const updateGroup = (gid, patch) => {
    persistLayout({
      ...layout,
      groups: layout.groups.map((g) => (g.id === gid ? { ...g, ...patch } : g)),
    });
  };

  const removeGroup = (gid) => {
    if (gid === UNGROUPED_ID) return;
    // Move its faenas back to "ungrouped"
    const nextFaenaGroup = { ...layout.faenaGroup };
    for (const fid in nextFaenaGroup) {
      if (nextFaenaGroup[fid] === gid) delete nextFaenaGroup[fid];
    }
    persistLayout({
      ...layout,
      groups: layout.groups.filter((g) => g.id !== gid),
      faenaGroup: nextFaenaGroup,
    });
  };

  const setFaenaCardColor = (faenaId, color) => {
    const next = { ...layout.faenaColor };
    if (color == null) delete next[faenaId];
    else next[faenaId] = color;
    persistLayout({ ...layout, faenaColor: next });
  };

  const colorOf = (faena) => {
    const override = layout.faenaColor[faena.id];
    if (override) return override;
    const gid = layout.faenaGroup[faena.id] || UNGROUPED_ID;
    return layout.groups.find((g) => g.id === gid)?.color || null;
  };

  const submitFaena = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        name: faenaForm.data.name.trim(),
        location: faenaForm.data.location || "",
        notes: faenaForm.data.notes || "",
      };
      if (faenaForm.mode === "create") {
        const created = await faenasService.create(payload);
        persistOrder([...order, created.id]);
      } else {
        await faenasService.update(faenaForm.data.id, payload);
      }
      setFaenaForm(null);
      await loadFaenas();
    } finally {
      setBusy(false);
    }
  };

  const submitSub = async (e) => {
    e.preventDefault();
    const { mode, faenaId, data } = subForm;
    setBusy(true);
    try {
      if (mode === "create") await subfaenasService.create({ ...data, faenaId });
      else await subfaenasService.update(data.id, { name: data.name, notes: data.notes || "" });
      setSubForm(null);
      await loadSubs(faenaId);
    } finally {
      setBusy(false);
    }
  };

  const cyclePrefix = (faenaId, subfaenaId) => {
    const f = faenas.find((x) => x.id === faenaId);
    const subList = subsByFaena[faenaId] || [];
    const s = subList.find((x) => x.id === subfaenaId);
    const parts = [];
    if (f?.name) parts.push(f.name);
    if (s?.name) parts.push(s.name);
    return parts.length ? parts.join("/") + "/" : "";
  };

  const submitCycle = async (e) => {
    e.preventDefault();
    const { mode, faenaId, data } = cycleForm;
    if (mode === "create") {
      const existing = cyclesByFaena[faenaId] || [];
      const subs = subsByFaena[faenaId] || [];
      if (!data.subfaenaId && subs.length > 0) {
        alert("La faena tiene subfaenas. Selecciona una subfaena para el ciclo.");
        return;
      }
    }
    setBusy(true);
    try {
      // Determinar labores y datos a importar desde el ciclo origen (si aplica).
      let labors;
      let importPlan = null; // { source, labors, sourceLaborById, oldToNewLaborId }
      if (mode === "create" && data.importEnabled && data.importSourceId) {
        const source = (data.importCandidates || []).find((c) => c.id === data.importSourceId);
        const picked = (source?.labors || []).filter((l) => (data.importLaborIds || new Set()).has(l.id));
        if (picked.length === 0) {
          alert("Marcá al menos una labor a clonar (o desactivá la importación).");
          setBusy(false);
          return;
        }
        const oldToNewLaborId = new Map();
        labors = picked.map((l) => {
          const id = newId();
          oldToNewLaborId.set(l.id, id);
          // Copiamos la config completa (todo lo que no sea id) — el form
          // de la labor en CycleDetail solo lee campos conocidos.
          const { id: _drop, ...rest } = l;
          return { ...rest, id };
        });
        importPlan = { source, picked, oldToNewLaborId };
      } else {
        labors = data.labors && data.labors.length ? data.labors : defaultLabors();
      }

      const prefix = cyclePrefix(faenaId, data.subfaenaId);
      const suffix = (data.labelSuffix ?? data.label ?? "").trim();

      // Días: los días marcados en `importDays` definen la lista del nuevo
      // ciclo (y también restringen qué workdays/precios se importan).
      const importDaysSet = data.importDays || new Set();
      let nextDays = data.days || [];
      if (mode === "create" && importPlan) {
        nextDays = (importPlan.source.days || []).filter((d) => importDaysSet.has(d));
      }

      // dayPrices: si pidieron copiarlos, re-mapeamos las claves de laborId
      // de las labores seleccionadas y filtramos por días seleccionados.
      let nextDayPrices = undefined;
      if (mode === "create" && importPlan && data.importCopyDayPrices) {
        const src = importPlan.source.dayPrices || {};
        const out = {};
        for (const [oldLid, newLid] of importPlan.oldToNewLaborId) {
          const srcLab = src[oldLid];
          if (!srcLab) continue;
          const filtered = {};
          for (const d in srcLab) {
            if (importDaysSet.has(d)) filtered[d] = srcLab[d];
          }
          if (Object.keys(filtered).length > 0) out[newLid] = filtered;
        }
        if (Object.keys(out).length > 0) nextDayPrices = out;
      }

      const payload = {
        faenaId,
        subfaenaId: data.subfaenaId || null,
        label: prefix + suffix,
        startDate: data.startDate || todayStr(),
        notes: data.notes || "",
        status: data.status || "open",
        days: nextDays,
        labors,
        ...(nextDayPrices ? { dayPrices: nextDayPrices } : {}),
      };

      let createdCycleId = null;
      if (mode === "create") {
        const created = await cyclesService.create(payload);
        createdCycleId = created?.id || created;
      } else {
        await cyclesService.update(data.id, payload);
      }

      // Mover workdays: para cada labor importada, leemos sus workdays del
      // origen y los re-creamos en el nuevo ciclo (nuevo cycleId/laborId).
      // El docId encodea cycleId+laborId, así que es delete + create.
      // Saltamos workdays con payrollId para no romper snapshots de nómina.
      if (mode === "create" && importPlan && data.importMoveWorkdays && createdCycleId) {
        const oldCycleId = importPlan.source.id;
        let skippedPaid = 0;
        let moved = 0;
        for (const oldLabor of importPlan.picked) {
          const newLaborId = importPlan.oldToNewLaborId.get(oldLabor.id);
          const wds = await workdaysService.list({
            wheres: [["cycleId", "==", oldCycleId], ["laborId", "==", oldLabor.id]],
          });
          for (const w of wds) {
            if (w.payrollId) { skippedPaid += 1; continue; }
            // Solo movemos los workdays cuyo `date` está en la selección.
            if (!importDaysSet.has(w.date)) continue;
            // Derivar comboKey del docId (5to segmento). Si solo hay 4,
            // es "0_0" implícito (workday simple).
            const parts = String(w.id || "").split("__");
            const ck = parts.length >= 5 ? parts.slice(4).join("__") : "0_0";
            const newDocId = workdayDocId(createdCycleId, newLaborId, w.workerRut, w.date, ck);
            const { id: _oldId, cycleId: _cy, laborId: _la, ...rest } = w;
            await workdaysService.upsert(newDocId, {
              ...rest,
              cycleId: createdCycleId,
              laborId: newLaborId,
            });
            await workdaysService.remove(w.id);
            moved += 1;
          }
        }
        if (skippedPaid > 0) {
          alert(`Se movieron ${moved} workday(s). ${skippedPaid} ya estaban en una nómina y quedaron en el ciclo origen.`);
        }
      }

      setCycleForm(null);
      await loadCycles(faenaId);
    } finally {
      setBusy(false);
    }
  };

  const openCreateCycle = (faenaId, subfaenaId) => {
    if (!subfaenaId) {
      alert("Los ciclos se crean dentro de una subfaena. Crea primero una subfaena.");
      return;
    }
    const existing = cyclesByFaena[faenaId] || [];
    const scope = existing.filter((c) => c.subfaenaId === subfaenaId);

    // Lista de ciclos abiertos (no cerrados) del mismo ámbito que sirven como
    // posible fuente de import. Los presentamos ordenados por fecha más
    // reciente primero.
    const sortKey = (c) => c.endDate || c.startDate || c.createdAt?.toDate?.()?.toISOString?.() || "";
    const openCandidates = scope
      .filter((c) => c.status !== "closed")
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

    setCycleForm({
      mode: "create",
      faenaId,
      data: {
        labelSuffix: `Ciclo ${scope.length + 1}`,
        subfaenaId,
        startDate: todayStr(),
        notes: "",
        labors: defaultLabors(),
        // Import desde otro ciclo abierto. Opt-in: arranca apagado para no
        // ensuciar la creación rápida. Al activarlo seleccionamos por defecto
        // el más reciente con todas sus labores y todos sus días.
        importCandidates: openCandidates,
        importEnabled: false,
        importSourceId: openCandidates[0]?.id || null,
        importLaborIds: new Set((openCandidates[0]?.labors || []).map((l) => l.id)),
        importDays: new Set((openCandidates[0]?.days || [])),
        importCopyDayPrices: false,
        importMoveWorkdays: false,
      },
    });
  };

  const openEditCycle = (cycle, faenaId) => {
    const prefix = cyclePrefix(faenaId, cycle.subfaenaId);
    const suffix = (cycle.label || "").startsWith(prefix)
      ? (cycle.label || "").slice(prefix.length)
      : cycle.label || "";
    setCycleForm({
      mode: "edit",
      faenaId,
      data: {
        id: cycle.id,
        labelSuffix: suffix,
        subfaenaId: cycle.subfaenaId || "",
        startDate: cycle.startDate || todayStr(),
        notes: cycle.notes || "",
        labors: cycle.labors || defaultLabors(),
        days: cycle.days || [],
        status: cycle.status || "open",
      },
    });
  };

  const openCloseFlow = (cycle, faenaId) => {
    setCloseFlow({ cycle, faenaId, askNext: false, copyWorkers: true });
  };

  const confirmCloseCycle = async () => {
    if (!closeFlow) return;
    setBusy(true);
    try {
      await cyclesService.update(closeFlow.cycle.id, { status: "closed", endDate: todayStr() });
      setCloseFlow((s) => ({ ...s, askNext: true }));
      await loadCycles(closeFlow.faenaId);
    } finally {
      setBusy(false);
    }
  };

  const createNextCycle = async (copy) => {
    if (!closeFlow) return;
    setBusy(true);
    try {
      const prev = closeFlow.cycle;
      const cycles = cyclesByFaena[closeFlow.faenaId] || [];
      const scope = cycles.filter((c) =>
        prev.subfaenaId ? c.subfaenaId === prev.subfaenaId : !c.subfaenaId,
      );
      const nextNumber = scope.length + 1;
      const prevLabors = prev.labors || defaultLabors(prev.workers || []);
      const newLabors = prevLabors.map((l) => ({
        id: newId(),
        name: l.name,
        type: l.type,
        workers: copy ? l.workers || [] : [],
      }));
      await cyclesService.create({
        faenaId: closeFlow.faenaId,
        subfaenaId: prev.subfaenaId || null,
        label: cyclePrefix(closeFlow.faenaId, prev.subfaenaId) + `Ciclo ${nextNumber}`,
        startDate: todayStr(),
        notes: "",
        status: "open",
        days: [],
        labors: newLabors,
      });
      setCloseFlow(null);
      await loadCycles(closeFlow.faenaId);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    setConfirm((c) => ({ ...c, busy: true }));
    try {
      try {
      if (confirm.kind === "faena") {
        // Bypass cache for diagnostics
        cyclesService.invalidate();
        subfaenasService.invalidate();
        const subs = await subfaenasService.list({ wheres: [["faenaId", "==", confirm.item.id]] });
        const cyc = await cyclesService.list({ wheres: [["faenaId", "==", confirm.item.id]] });
        console.log(`[Faena delete] Faena ${confirm.item.id} (${confirm.item.name})`);
        console.log(`  Subfaenas asociadas (${subs.length}):`, subs.map((s) => ({ id: s.id, name: s.name })));
        console.log(`  Ciclos asociados (${cyc.length}):`, cyc.map((c) => ({ id: c.id, label: c.label, status: c.status, subfaenaId: c.subfaenaId })));

        const blockers = [];
        if (subs.length) blockers.push(`${subs.length} subfaena(s): ${subs.map((s) => s.name).join(", ")}`);
        if (cyc.length) blockers.push(`${cyc.length} ciclo(s): ${cyc.map((c) => c.label).join(", ")}`);

        if (blockers.length) {
          if (!isAdmin) {
            alert(`No se puede eliminar:\n${blockers.join("\n")}\n\n(Pide a un admin para borrado en cascada)`);
            setConfirm(null);
            return;
          }
          const ok = window.confirm(
            `Bloqueado por:\n - ${blockers.join("\n - ")}\n\n¿Eliminar TODO en cascada (subfaenas + ciclos + producción)?\nRevisa la consola del navegador para ver los IDs.\nEsta acción no se puede deshacer.`,
          );
          if (!ok) { setConfirm(null); return; }

          for (const c of cyc) {
            const wds = await workdaysService.list({ wheres: [["cycleId", "==", c.id]] });
            console.log(`  Borrando ciclo ${c.id} (${c.label}) con ${wds.length} workdays`);
            for (const w of wds) await workdaysService.remove(w.id);
            await cyclesService.remove(c.id);
          }
          for (const s of subs) {
            console.log(`  Borrando subfaena ${s.id} (${s.name})`);
            await subfaenasService.remove(s.id);
          }
        }

        console.log(`  Borrando faena ${confirm.item.id}`);
        await faenasService.remove(confirm.item.id);
        persistOrder(order.filter((id) => id !== confirm.item.id));
        if (selectedId === confirm.item.id) setSelectedId(null);
        await loadFaenas();
      } else if (confirm.kind === "sub") {
        await subfaenasService.remove(confirm.item.id);
        await loadSubs(confirm.item.faenaId);
      } else if (confirm.kind === "cycle") {
        try {
          const wds = await workdaysService.list({
            wheres: [["cycleId", "==", confirm.item.id]],
          });
          if (wds.length) {
            if (isAdmin) {
              const ok = window.confirm(
                `El ciclo "${confirm.item.label}" tiene ${wds.length} registro(s) de producción.\n\n¿Eliminar TODO en cascada (producción + ciclo)?\nEsta acción no se puede deshacer.`,
              );
              if (!ok) {
                setConfirm(null);
                return;
              }
              for (const w of wds) await workdaysService.remove(w.id);
            } else {
              alert(
                `No se puede eliminar: el ciclo tiene ${wds.length} registro(s) de producción. (Pide a un admin para cascada)`,
              );
              setConfirm(null);
              return;
            }
          }
          await cyclesService.remove(confirm.item.id);
          cyclesService.invalidate();
          await loadCycles(confirm.item.faenaId);
        } catch (err) {
          console.error("Error eliminando ciclo:", err);
          alert(`Error al eliminar ciclo: ${err?.message || err}`);
          setConfirm(null);
          return;
        }
      }
      setConfirm(null);
      } catch (err) {
        console.error("Error en eliminación:", err);
        alert(`Error al eliminar: ${err?.message || err}\nRevisa la consola para detalles.`);
        setConfirm(null);
      }
    } finally {
      setConfirm((c) => (c ? { ...c, busy: false } : null));
    }
  };

  const selected = faenas.find((f) => f.id === selectedId);
  const selectedSubs = selectedId ? subsByFaena[selectedId] : null;
  const selectedCycles = selectedId ? cyclesByFaena[selectedId] : null;
  const selectedGroupId = selectedId
    ? (layout.faenaGroup[selectedId] && layout.groups.some((g) => g.id === layout.faenaGroup[selectedId])
        ? layout.faenaGroup[selectedId]
        : UNGROUPED_ID)
    : null;

  const renderSelectedDetail = () =>
    selected && (
      <SelectedDetail
        selected={selected}
        subs={selectedSubs}
        cycles={selectedCycles}
        onCreateSub={() => setSubForm({ mode: "create", faenaId: selected.id, data: { ...emptySub } })}
        onEditSub={(s) => setSubForm({ mode: "edit", faenaId: selected.id, data: { ...s } })}
        onDeleteSub={(s) => setConfirm({ kind: "sub", item: s, message: `¿Eliminar la subfaena "${s.name}"?` })}
        onCreateCycle={(subfaenaId) => openCreateCycle(selected.id, subfaenaId || "")}
        onEditCycle={(c) => openEditCycle(c, selected.id)}
        onOpenCloseFlow={(c) => openCloseFlow(c, selected.id)}
        onReopenCycle={async (c) => {
          await cyclesService.update(c.id, { status: "open", endDate: null });
          await loadCycles(selected.id);
        }}
        onDeleteCycle={(c) =>
          setConfirm({
            kind: "cycle",
            item: { ...c, faenaId: selected.id },
            message: `¿Eliminar el ciclo "${c.label}"?`,
          })
        }
      />
    );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Faenas</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Arrastra las tarjetas para reordenarlas o moverlas entre grupos.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setEditLayout((v) => !v)}
            className={`rounded-md border px-3 py-2 text-sm transition-colors ${
              editLayout
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
            }`}
          >
            {editLayout ? "✓ Listo" : "⚙ Organizar"}
          </button>
          {editLayout && (
            <button
              onClick={addGroup}
              className="rounded-md border border-dashed border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
            >
              + Grupo
            </button>
          )}
          <button
            onClick={() => setFaenaForm({ mode: "create", data: { ...emptyFaena } })}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)]"
          >
            + Nueva faena
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-[var(--color-muted)]">Cargando...</div>
      ) : faenas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center text-[var(--color-muted)]">
          No hay faenas. Crea la primera.
        </div>
      ) : (
        <div className="space-y-6">
          {layout.groups.map((g) => {
            const groupFaenas = faenasByGroup[g.id] || [];
            // Hide empty ungrouped section unless editing
            if (g.id === UNGROUPED_ID && groupFaenas.length === 0 && !editLayout) return null;
            const isDropTarget = dropOverGroupId === g.id;
            return (
              <section
                key={g.id}
                onDragOver={onGroupDragOver(g.id)}
                onDrop={onGroupDrop(g.id)}
                onDragLeave={() => setDropOverGroupId(null)}
                className={`rounded-lg border-2 ${
                  isDropTarget ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/30" : "border-transparent"
                } transition-colors`}
              >
                <GroupHeader
                  group={g}
                  count={groupFaenas.length}
                  editable={editLayout}
                  isUngrouped={g.id === UNGROUPED_ID}
                  onUpdate={(patch) => updateGroup(g.id, patch)}
                  onRemove={() => removeGroup(g.id)}
                />
                {groupFaenas.length === 0 ? (
                  <div className={`rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-muted)] ${editLayout ? "" : "hidden"}`}>
                    Arrastra una tarjeta aquí.
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {groupFaenas.map((f) => {
                      const subsCount = subsByFaena[f.id]?.length;
                      const cyclesCount = cyclesByFaena[f.id]?.length;
                      const isSelected = selectedId === f.id;
                      const cardColor = colorOf(f);
                      return (
                        <Fragment key={f.id}><div
                          draggable
                          onDragStart={onDragStart(f.id)}
                          onDragOver={onDragOver(f.id)}
                          onDragLeave={onDragLeave}
                          onDrop={onDrop(f.id)}
                          onDragEnd={onDragEnd}
                          onClick={() => setSelectedId(isSelected ? null : f.id)}
                          data-dragging={dragId === f.id}
                          data-drop-over={dropOverId === f.id}
                          style={cardColor ? { borderLeft: `4px solid ${cardColor}` } : undefined}
                          className={`dnd-card group relative cursor-pointer rounded-lg border bg-[var(--color-surface)] p-4 shadow-sm hover:border-[var(--color-border-strong)] hover:shadow-md ${
                            isSelected ? "border-[var(--color-accent)] shadow-md" : "border-[var(--color-border)]"
                          }`}
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 select-none text-[var(--color-muted)] opacity-50 group-hover:opacity-100" title="Arrastra para reordenar">⠿</span>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold leading-tight">{f.name}</span>
                                </div>
                                {f.location && <div className="mt-0.5 text-xs text-[var(--color-muted)]">{f.location}</div>}
                              </div>
                            </div>
                            <div onClick={(e) => e.stopPropagation()}>
                              <ColorPickerButton
                                value={layout.faenaColor[f.id] ?? null}
                                onChange={(c) => setFaenaCardColor(f.id, c)}
                              />
                            </div>
                          </div>
                          {f.notes && <p className="mb-3 line-clamp-2 text-xs text-[var(--color-muted)]">{f.notes}</p>}
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3 text-xs">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[var(--color-muted)]">
                                {subsCount != null ? `${subsCount} sub` : "—"}
                              </span>
                              <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">
                                {cyclesCount != null ? `${cyclesCount} ciclos` : "—"}
                              </span>
                            </div>
                            <div className="ml-auto flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => setFaenaForm({ mode: "edit", data: { ...f } })}
                                className="rounded-md px-2 py-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                              >
                                Editar
                              </button>
                              <button
                                onClick={() => setConfirm({ kind: "faena", item: f, message: `¿Eliminar la faena "${f.name}"?` })}
                                className="rounded-md px-2 py-1 text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                              >
                                Eliminar
                              </button>
                            </div>
                          </div>
                        </div>
                        {isMobile && isSelected && (
                          <div className="col-span-full">
                            {renderSelectedDetail()}
                          </div>
                        )}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
                {!isMobile && selectedGroupId === g.id && renderSelectedDetail()}
              </section>
            );
          })}
          {!isMobile && selected && !layout.groups.some((g) => g.id === selectedGroupId) && renderSelectedDetail()}
        </div>
      )}

      {/* Faena modal */}
      <Modal
        open={!!faenaForm}
        onClose={() => !busy && setFaenaForm(null)}
        title={faenaForm?.mode === "edit" ? "Editar faena" : "Nueva faena"}
      >
        {faenaForm && (
          <form onSubmit={submitFaena} className="space-y-4">
            <TextField
              label="Nombre"
              required
              autoFocus
              value={faenaForm.data.name}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, name: v } }))}
            />
            <TextField
              label="Ubicación"
              value={faenaForm.data.location}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, location: v } }))}
            />
            <TextField
              label="Notas"
              value={faenaForm.data.notes}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFaenaForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Subfaena modal */}
      <Modal
        open={!!subForm}
        onClose={() => !busy && setSubForm(null)}
        title={subForm?.mode === "edit" ? "Editar subfaena" : "Nueva subfaena"}
      >
        {subForm && (
          <form onSubmit={submitSub} className="space-y-4">
            <TextField
              label="Nombre"
              required
              autoFocus
              value={subForm.data.name}
              onChange={(v) => setSubForm((s) => ({ ...s, data: { ...s.data, name: v } }))}
            />
            <TextField
              label="Notas"
              value={subForm.data.notes}
              onChange={(v) => setSubForm((s) => ({ ...s, data: { ...s.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSubForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Cycle modal */}
      <Modal
        open={!!cycleForm}
        onClose={() => !busy && setCycleForm(null)}
        title={cycleForm?.mode === "edit" ? "Editar ciclo" : "Nuevo ciclo"}
      >
        {cycleForm && (
          <form onSubmit={submitCycle} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm text-[var(--color-muted)]">
                Etiqueta<span className="ml-0.5 text-[var(--color-danger)]">*</span>
              </span>
              <div className="flex items-stretch overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <span className="flex items-center bg-[var(--color-surface)] px-2 text-xs text-[var(--color-muted)] border-r border-[var(--color-border)]">
                  {cyclePrefix(cycleForm.faenaId, cycleForm.data.subfaenaId) || "—"}
                </span>
                <input
                  required
                  autoFocus
                  value={cycleForm.data.labelSuffix ?? ""}
                  onChange={(e) => setCycleForm((c) => ({ ...c, data: { ...c.data, labelSuffix: e.target.value } }))}
                  placeholder="Ciclo 1"
                  className="flex-1 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <span className="mt-1 block text-[10px] text-[var(--color-muted)]">
                El prefijo Faena/Subfaena/ es fijo
              </span>
            </label>
            {selectedSubs && selectedSubs.length > 0 && (
              <Select
                label="Subfaena"
                required
                value={cycleForm.data.subfaenaId || ""}
                onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, subfaenaId: v } }))}
                options={selectedSubs.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Selecciona la subfaena"
              />
            )}
            <TextField
              label="Fecha inicio"
              type="date"
              value={cycleForm.data.startDate}
              onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, startDate: v } }))}
            />
            <TextField
              label="Notas"
              value={cycleForm.data.notes}
              onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, notes: v } }))}
            />
            {cycleForm.mode === "create" && (cycleForm.data.importCandidates || []).length > 0 && (
              <ImportSection
                data={cycleForm.data}
                onChange={(patch) =>
                  setCycleForm((c) => ({ ...c, data: { ...c.data, ...patch } }))
                }
              />
            )}
            <p className="text-xs text-[var(--color-muted)]">
              {cycleForm.mode === "create" && cycleForm.data.importEnabled
                ? "Se clonarán las labores marcadas. Si activaste 'Mover workdays', se transferirán al nuevo ciclo y desaparecerán del origen."
                : 'Se creará con una labor "Principal" por defecto. Podrás agregar más al abrir el ciclo.'}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCycleForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Close cycle flow */}
      <Modal
        open={!!closeFlow}
        onClose={() => !busy && setCloseFlow(null)}
        title={closeFlow?.askNext ? "¿Crear nuevo ciclo?" : "Cerrar ciclo"}
        footer={
          closeFlow?.askNext ? (
            <>
              <button
                onClick={() => setCloseFlow(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                No, gracias
              </button>
              <button
                onClick={() => createNextCycle(closeFlow.copyWorkers)}
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Crear ciclo"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setCloseFlow(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                onClick={confirmCloseCycle}
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Cerrar ciclo"}
              </button>
            </>
          )
        }
      >
        {closeFlow && !closeFlow.askNext && (
          <p className="text-sm text-[var(--color-muted)]">
            Vas a cerrar <span className="text-[var(--color-text)]">{closeFlow.cycle.label}</span>.
          </p>
        )}
        {closeFlow?.askNext && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-muted)]">
              El ciclo fue cerrado. ¿Crear uno nuevo a continuación?
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={closeFlow.copyWorkers}
                onChange={(e) => setCloseFlow((s) => ({ ...s, copyWorkers: e.target.checked }))}
              />
              Copiar trabajadores de cada labor del ciclo anterior
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title="Eliminar"
        confirmLabel="Eliminar"
        danger
        message={confirm?.message}
        busy={confirm?.busy}
        onCancel={() => !confirm?.busy && setConfirm(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

// Sección del modal de creación de ciclo que ofrece importar desde otro
// ciclo abierto del mismo ámbito. Se renderiza solo si hay al menos un
// candidato. Permite elegir cuáles labores clonar y si copiar días/precios o
// mover los workdays existentes al nuevo ciclo.
function ImportSection({ data, onChange }) {
  const candidates = data.importCandidates || [];
  const source = candidates.find((c) => c.id === data.importSourceId) || null;
  const sourceLabors = source?.labors || [];
  const sourceDays = source?.days || [];
  const selectedIds = data.importLaborIds || new Set();
  const selectedDays = data.importDays || new Set();

  const toggleLabor = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ importLaborIds: next });
  };
  const allLaborsOn = sourceLabors.every((l) => selectedIds.has(l.id));
  const toggleAllLabors = () => {
    onChange({ importLaborIds: new Set(allLaborsOn ? [] : sourceLabors.map((l) => l.id)) });
  };
  const toggleDay = (d) => {
    const next = new Set(selectedDays);
    if (next.has(d)) next.delete(d); else next.add(d);
    onChange({ importDays: next });
  };
  const allDaysOn = sourceDays.length > 0 && sourceDays.every((d) => selectedDays.has(d));
  const toggleAllDays = () => {
    onChange({ importDays: new Set(allDaysOn ? [] : sourceDays) });
  };
  const onPickSource = (id) => {
    const c = candidates.find((x) => x.id === id);
    onChange({
      importSourceId: id,
      importLaborIds: new Set((c?.labors || []).map((l) => l.id)),
      importDays: new Set((c?.days || [])),
    });
  };

  return (
    <div className="rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-accent-soft)]/30 p-3 text-sm space-y-2">
      <label className="flex items-start gap-2 font-medium">
        <input
          type="checkbox"
          checked={!!data.importEnabled}
          onChange={(e) => onChange({ importEnabled: e.target.checked })}
          className="mt-0.5"
        />
        <span>Importar desde un ciclo abierto del mismo ámbito</span>
      </label>
      {data.importEnabled && (
        <div className="space-y-3 pl-6">
          {candidates.length > 1 && (
            <label className="block text-xs">
              <span className="text-[var(--color-muted)]">Ciclo origen</span>
              <select
                value={data.importSourceId || ""}
                onChange={(e) => onPickSource(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · abierto
                  </option>
                ))}
              </select>
            </label>
          )}
          {sourceLabors.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-[var(--color-muted)]">Labores a clonar</span>
                <button
                  type="button"
                  onClick={toggleAllLabors}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {allLaborsOn ? "Ninguna" : "Todas"}
                </button>
              </div>
              <div className="max-h-40 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                {sourceLabors.map((l) => {
                  const workers = (l.workers || []).length;
                  return (
                    <label
                      key={l.id}
                      className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-xs last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(l.id)}
                        onChange={() => toggleLabor(l.id)}
                      />
                      <span className="flex-1">
                        <b>{l.name}</b>{" "}
                        <span className="text-[var(--color-muted)]">· {l.type}</span>
                      </span>
                      <span className="text-[var(--color-muted)]">
                        {workers} trab.
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          {sourceDays.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-[var(--color-muted)]">Días a importar</span>
                <button
                  type="button"
                  onClick={toggleAllDays}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {allDaysOn ? "Ninguno" : "Todos"}
                </button>
              </div>
              <div className="flex flex-wrap gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
                {sourceDays.map((d) => {
                  const on = selectedDays.has(d);
                  return (
                    <button
                      type="button"
                      key={d}
                      onClick={() => toggleDay(d)}
                      className={`rounded-full border px-2 py-0.5 text-[10px] tabular-nums transition-opacity ${
                        on
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                          : "border-dashed border-[var(--color-border)] bg-transparent text-[var(--color-muted)] opacity-60"
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-muted)]">
                La lista de días del nuevo ciclo será solo las fechas marcadas.
                Mover/copiar workdays y precios queda restringido a estas fechas.
              </p>
            </div>
          )}
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!data.importCopyDayPrices}
              onChange={(e) => onChange({ importCopyDayPrices: e.target.checked })}
              className="mt-0.5"
            />
            <span>Copiar precios por día (combos/tiers/piso) de las labores y días marcados</span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!data.importMoveWorkdays}
              onChange={(e) => onChange({ importMoveWorkdays: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              <b>Mover</b> los workdays de las labores seleccionadas al nuevo ciclo.{" "}
              <span className="text-[var(--color-danger)]">
                ⚠ Desaparecen del ciclo origen.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle, subName, onEdit, onOpenCloseFlow, onReopen, onDelete }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {cycle.label}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              cycle.status === "closed"
                ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            }`}
          >
            {cycle.status === "closed" ? "cerrado" : "abierto"}
          </span>
        </div>
        <div className="text-xs text-[var(--color-muted)]">
          {cycle.startDate || "—"}
          {cycle.endDate && ` → ${cycle.endDate}`}
          {subName && ` · ${subName}`}
          {` · ${(cycle.labors || []).length} labores`}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap gap-1.5">
        <Link
          to={`/cycles/${cycle.id}`}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
        >
          Abrir
        </Link>
        {onEdit && (
          <button
            onClick={() => onEdit(cycle)}
            title="Renombrar / editar"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
          >
            ✏ Renombrar
          </button>
        )}
        {cycle.status !== "closed" ? (
          <button
            onClick={() => onOpenCloseFlow(cycle)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
          >
            Cerrar
          </button>
        ) : (
          onReopen && (
            <button
              onClick={() => onReopen(cycle)}
              title="Reabrir ciclo cerrado"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            >
              ↻ Reabrir
            </button>
          )
        )}
        <button
          onClick={() => onDelete(cycle)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
        >
          Eliminar
        </button>
      </div>
    </li>
  );
}

function SelectedDetail({
  selected,
  subs,
  cycles,
  onCreateSub,
  onEditSub,
  onDeleteSub,
  onCreateCycle,
  onEditCycle,
  onOpenCloseFlow,
  onReopenCycle,
  onDeleteCycle,
}) {
  const cyclesBySub = (cycles || []).reduce((acc, c) => {
    if (!c.subfaenaId) return acc;
    (acc[c.subfaenaId] ||= []).push(c);
    return acc;
  }, {});
  const orphanCycles = (cycles || []).filter((c) => !c.subfaenaId);

  const hasSubs = (subs || []).length > 0;

  return (
    <div className="mt-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Detalle</div>
          <div className="text-base font-semibold">{selected.name}</div>
        </div>
        <button
          onClick={onCreateSub}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Subfaena
        </button>
      </div>

      {!cycles || !subs ? (
        <div className="px-5 py-4 text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : !hasSubs ? (
        <div className="px-5 py-6 text-center text-sm text-[var(--color-muted)]">
          <p>Esta faena no tiene subfaenas.</p>
          <p className="mt-1 text-xs">
            Los ciclos se crean dentro de una subfaena. Crea la primera para comenzar.
          </p>
          <button
            onClick={onCreateSub}
            className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
          >
            Crear subfaena
          </button>
          {orphanCycles.length > 0 && (
            <div className="mt-4 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-left text-xs text-[var(--color-warning)]">
              <b>Atención:</b> esta faena tiene {orphanCycles.length} ciclo(s) legacy sin subfaena.
              Bórralos desde la consola Firebase o usa el cascada admin al eliminar la faena.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center justify-between text-xs uppercase tracking-wider text-[var(--color-muted)]">
            <span>Subfaenas ({subs.length})</span>
            <button
              onClick={onCreateSub}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
            >
              + Subfaena
            </button>
          </div>
          {subs.map((s) => {
            const subCycles = cyclesBySub[s.id] || [];
            return (
              <div key={s.id} className="rounded-md border border-[var(--color-border)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    {s.notes && <div className="truncate text-xs text-[var(--color-muted)]">{s.notes}</div>}
                  </div>
                  <div className="ml-auto flex shrink-0 flex-wrap gap-1">
                    <button
                      onClick={() => onCreateCycle(s.id)}
                      className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
                    >
                      + Ciclo
                    </button>
                    <button
                      onClick={() => onEditSub(s)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => onDeleteSub(s)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
                {subCycles.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-[var(--color-muted)]">Sin ciclos.</div>
                ) : (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {subCycles.map((c) => (
                      <CycleRow
                        key={c.id}
                        cycle={c}
                        onEdit={onEditCycle}
                        onOpenCloseFlow={onOpenCloseFlow}
                        onReopen={onReopenCycle}
                        onDelete={onDeleteCycle}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Group sub-components
// ============================================================

function GroupHeader({ group, count, editable, isUngrouped, onUpdate, onRemove }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(group.name);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => setName(group.name), [group.name]);

  const commitName = () => {
    setEditingName(false);
    if (name.trim() && name.trim() !== group.name) onUpdate({ name: name.trim() });
    else setName(group.name);
  };

  return (
    <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2">
      <div className="flex items-center gap-2 min-w-0">
        {group.color && (
          <span
            aria-hidden
            className="h-3 w-3 flex-shrink-0 rounded-sm"
            style={{ backgroundColor: group.color }}
          />
        )}
        {editable && !isUngrouped && editingName ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") { setEditingName(false); setName(group.name); }
            }}
            autoFocus
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-base font-semibold outline-none focus:border-[var(--color-accent)]"
          />
        ) : (
          <h2
            onClick={() => editable && !isUngrouped && setEditingName(true)}
            className={`text-base font-semibold ${editable && !isUngrouped ? "cursor-pointer hover:text-[var(--color-accent)]" : ""}`}
          >
            {group.name}
          </h2>
        )}
        <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-muted)]">
          {count}
        </span>
      </div>
      {editable && (
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              title="Color del grupo"
            >
              <span
                className="inline-block h-3 w-3 rounded-sm align-middle"
                style={{ backgroundColor: group.color || "transparent", border: group.color ? "none" : "1px dashed var(--color-border-strong)" }}
              />
              <span className="ml-1 align-middle">color</span>
            </button>
            {pickerOpen && (
              <ColorPalette
                onPick={(c) => { onUpdate({ color: c }); setPickerOpen(false); }}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
          {!isUngrouped && (
            <button
              onClick={() => {
                if (count > 0 && !confirm(`Quitar el grupo "${group.name}"? Las ${count} faena(s) volverán a "Sin grupo".`)) return;
                onRemove();
              }}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ColorPickerButton({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Color de la tarjeta"
        className="h-5 w-5 rounded-full border border-[var(--color-border)] opacity-50 hover:opacity-100"
        style={{ backgroundColor: value || "transparent" }}
      />
      {open && <ColorPalette onPick={(c) => { onChange(c); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ColorPalette({ onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg"
    >
      <div className="grid grid-cols-5 gap-1">
        {FAENA_PALETTE.map((c) => (
          <button
            key={c.label}
            onClick={() => onPick(c.value)}
            title={c.label}
            className="h-6 w-6 rounded-md border border-[var(--color-border)] hover:scale-110 transition-transform"
            style={{
              backgroundColor: c.value || "transparent",
              backgroundImage: c.value
                ? "none"
                : "linear-gradient(135deg, transparent 45%, var(--color-danger) 45%, var(--color-danger) 55%, transparent 55%)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
