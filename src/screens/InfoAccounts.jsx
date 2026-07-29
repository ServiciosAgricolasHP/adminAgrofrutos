import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toBlob, toPng } from "html-to-image";
import Modal from "../Components/Modal";
import { contactCardsService } from "../services";
import { useToast } from "../contexts/ToastContext";
import {
  BANKS,
  ACCOUNT_TYPES,
  bankName,
  accountTypeLabel,
  DEFAULT_BANK_CODE,
  ACCOUNT_TYPE_RUT,
} from "../utils/banks";
import { formatRutForDisplay, normalizeRut } from "../utils/rutUtils";

// Módulo "Información y Cuentas": libreta compartida de fichas (persona o
// empresa) con datos de contacto + varias cuentas bancarias. Pensada para
// tener a mano datos que se copian seguido (ej. pegar los datos de una
// transferencia en WhatsApp). Todo es compartido entre usuarios (favoritos
// incluidos, guardados en el propio doc).

const TYPE_META = {
  persona: { icon: "👤", label: "Persona", nameLabel: "Nombre" },
  empresa: { icon: "🏢", label: "Empresa", nameLabel: "Razón social" },
};

const newAccountId = () =>
  `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const emptyAccount = () => ({
  id: newAccountId(),
  label: "",
  titular: "",
  rutTitular: "",
  bankCode: DEFAULT_BANK_CODE,
  accountType: ACCOUNT_TYPE_RUT,
  accountNumber: "",
  email: "",
});

const emptyCard = (type = "persona") => ({
  type,
  name: "",
  rut: "",
  phone: "",
  email: "",
  address: "",
  giro: "",
  note: "",
  accounts: [],
  favorite: false,
});

// Texto plano de una cuenta bancaria — formato "bloque de transferencia".
function accountToText(acc) {
  const lines = [];
  if (acc.titular) lines.push(`Titular: ${acc.titular}`);
  if (acc.rutTitular) lines.push(`RUT: ${formatRutForDisplay(acc.rutTitular)}`);
  lines.push(`Banco: ${bankName(acc.bankCode)}`);
  lines.push(`Tipo: ${accountTypeLabel(acc.accountType)}`);
  if (acc.accountNumber) lines.push(`N° Cuenta: ${acc.accountNumber}`);
  if (acc.email) lines.push(`Email: ${acc.email}`);
  return lines.join("\n");
}

// Texto plano de toda la ficha — datos + todas las cuentas.
function cardToText(card) {
  const meta = TYPE_META[card.type] || TYPE_META.persona;
  const lines = [];
  if (card.name) lines.push(`${meta.nameLabel}: ${card.name}`);
  if (card.rut) lines.push(`RUT: ${formatRutForDisplay(card.rut)}`);
  if (card.giro) lines.push(`Giro: ${card.giro}`);
  if (card.address) lines.push(`Dirección: ${card.address}`);
  if (card.phone) lines.push(`Teléfono: ${card.phone}`);
  if (card.email) lines.push(`Email: ${card.email}`);
  if (card.note) lines.push(`Nota: ${card.note}`);
  const accounts = Array.isArray(card.accounts) ? card.accounts : [];
  accounts.forEach((acc, i) => {
    const tag = acc.label ? ` (${acc.label})` : "";
    lines.push("", `— Cuenta ${i + 1}${tag} —`, accountToText(acc));
  });
  return lines.join("\n");
}

export default function InfoAccounts() {
  const toast = useToast();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null); // card en edición/creación
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Captura de imagen on-demand: seteamos la tarjeta a renderizar off-screen,
  // el effect la captura y limpia. Evita mantener N nodos ocultos montados.
  const [imageJob, setImageJob] = useState(null); // { card }
  const imageRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await contactCardsService.list({ order: ["name", "asc"] });
      setCards(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copy = async (text, label = "Dato") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copiado`);
    } catch {
      toast.error("No se pudo copiar");
    }
  };

  // Captura la tarjeta estilizada off-screen y la copia al portapapeles. Si el
  // navegador no soporta copiar imágenes (algunos móviles), cae a descarga.
  useEffect(() => {
    if (!imageJob) return;
    let cancelled = false;
    (async () => {
      // Dos rAF para asegurar que el nodo off-screen ya está en layout.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled || !imageRef.current) return;
      try {
        const canCopyImage =
          typeof ClipboardItem !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.write === "function";
        if (canCopyImage) {
          const blob = await toBlob(imageRef.current, { pixelRatio: 2, cacheBust: true });
          if (!blob) throw new Error("blob vacío");
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toast.success("Imagen copiada al portapapeles");
        } else {
          const dataUrl = await toPng(imageRef.current, { pixelRatio: 2, cacheBust: true });
          const a = document.createElement("a");
          a.download = `ficha_${(imageJob.card.name || "ficha").replace(/\s+/g, "_")}.png`;
          a.href = dataUrl;
          a.click();
          toast.success("Imagen descargada");
        }
      } catch {
        // Fallback final: intentar descarga si el copy falló.
        try {
          const dataUrl = await toPng(imageRef.current, { pixelRatio: 2, cacheBust: true });
          const a = document.createElement("a");
          a.download = `ficha_${(imageJob.card.name || "ficha").replace(/\s+/g, "_")}.png`;
          a.href = dataUrl;
          a.click();
          toast.success("Imagen descargada");
        } catch {
          toast.error("No se pudo generar la imagen");
        }
      } finally {
        if (!cancelled) setImageJob(null);
      }
    })();
    return () => { cancelled = true; };
  }, [imageJob, toast]);

  const toggleFavorite = async (card) => {
    // Actualización optimista para que la tarjeta salte de sección al instante.
    const next = !card.favorite;
    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, favorite: next } : c)));
    try {
      await contactCardsService.update(card.id, { favorite: next });
    } catch {
      toast.error("No se pudo actualizar el favorito");
      setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, favorite: card.favorite } : c)));
    }
  };

  const saveCard = async (draft) => {
    const payload = {
      type: draft.type,
      name: (draft.name || "").trim(),
      rut: draft.rut ? normalizeRut(draft.rut) : "",
      phone: (draft.phone || "").trim(),
      email: (draft.email || "").trim(),
      address: (draft.address || "").trim(),
      giro: draft.type === "empresa" ? (draft.giro || "").trim() : "",
      note: (draft.note || "").trim(),
      favorite: !!draft.favorite,
      accounts: (draft.accounts || []).map((a) => ({
        id: a.id || newAccountId(),
        label: (a.label || "").trim(),
        titular: (a.titular || "").trim(),
        rutTitular: a.rutTitular ? normalizeRut(a.rutTitular) : "",
        bankCode: a.bankCode || DEFAULT_BANK_CODE,
        accountType: Number(a.accountType),
        accountNumber: (a.accountNumber || "").trim(),
        email: (a.email || "").trim(),
      })),
    };
    if (draft.id) {
      await contactCardsService.update(draft.id, payload);
    } else {
      await contactCardsService.create(payload);
    }
    setEditing(null);
    await load();
    toast.success("Ficha guardada");
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const c = confirmDelete;
    setConfirmDelete(null);
    await contactCardsService.remove(c.id);
    await load();
    toast.success("Ficha eliminada");
  };

  const favorites = useMemo(() => cards.filter((c) => c.favorite), [cards]);
  const rest = useMemo(() => {
    const q = search.trim().toLowerCase();
    const nonFav = cards.filter((c) => !c.favorite);
    if (!q) return nonFav;
    return nonFav.filter((c) =>
      [c.name, c.rut, c.giro, c.email, c.phone, c.address]
        .some((v) => String(v || "").toLowerCase().includes(q)),
    );
  }, [cards, search]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Información y Cuentas</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Fichas de personas y empresas con sus datos bancarios, listas para copiar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(emptyCard("persona"))}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Nueva ficha
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-[var(--color-muted)]">Cargando…</div>
      ) : cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-12 text-center text-sm text-[var(--color-muted)]">
          Todavía no hay fichas. Creá la primera con “+ Nueva ficha”.
        </div>
      ) : (
        <>
          {/* Favoritas */}
          {favorites.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-muted)]">
                ⭐ Favoritas
                <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px]">{favorites.length}</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {favorites.map((c) => (
                  <ContactCard
                    key={c.id}
                    card={c}
                    onCopy={copy}
                    onCopyImage={(card) => setImageJob({ card })}
                    onToggleFavorite={toggleFavorite}
                    onEdit={setEditing}
                    onDelete={setConfirmDelete}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Buscador + resto */}
          <section>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, RUT, giro, email…"
              className="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            {rest.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
                {search.trim() ? "Sin resultados para la búsqueda." : "No hay fichas sin marcar como favoritas."}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rest.map((c) => (
                  <ContactCard
                    key={c.id}
                    card={c}
                    onCopy={copy}
                    onCopyImage={(card) => setImageJob({ card })}
                    onToggleFavorite={toggleFavorite}
                    onEdit={setEditing}
                    onDelete={setConfirmDelete}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* Nodo off-screen para capturar la imagen de la tarjeta elegida. */}
      {imageJob && (
        <div style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
          <ContactCardImage ref={imageRef} card={imageJob.card} />
        </div>
      )}

      {editing && (
        <ContactCardModal
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={saveCard}
        />
      )}

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title="Eliminar ficha"
          size="sm"
          footer={
            <>
              <button onClick={() => setConfirmDelete(null)} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
                Cancelar
              </button>
              <button onClick={doDelete} className="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-sm font-medium text-white">
                Eliminar
              </button>
            </>
          }
        >
          <p className="text-sm">
            ¿Eliminar la ficha <span className="font-semibold">{confirmDelete.name || "(sin nombre)"}</span>? Esta acción no se puede deshacer.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// Tarjeta de contacto
// ============================================================
function ContactCard({ card, onCopy, onCopyImage, onToggleFavorite, onEdit, onDelete }) {
  const meta = TYPE_META[card.type] || TYPE_META.persona;
  const accounts = Array.isArray(card.accounts) ? card.accounts : [];

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
        <span className="text-lg leading-none">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{card.name || "(sin nombre)"}</div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{meta.label}</div>
        </div>
        <button
          type="button"
          onClick={() => onToggleFavorite(card)}
          title={card.favorite ? "Quitar de favoritas" : "Marcar como favorita"}
          className="text-lg leading-none"
        >
          {card.favorite ? "⭐" : "☆"}
        </button>
      </div>

      {/* Datos */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <Field label="RUT" value={card.rut ? formatRutForDisplay(card.rut) : ""} copyValue={formatRutForDisplay(card.rut)} onCopy={onCopy} mono />
        {card.type === "empresa" && <Field label="Giro" value={card.giro} onCopy={onCopy} />}
        <Field label="Dirección" value={card.address} onCopy={onCopy} />
        <Field label="Teléfono" value={card.phone} onCopy={onCopy} mono />
        <Field label="Email" value={card.email} onCopy={onCopy} mono />
        <Field label="Nota" value={card.note} onCopy={onCopy} />
      </div>

      {/* Cuentas bancarias */}
      {accounts.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-3 py-2">
          {accounts.map((acc, i) => (
            <AccountBlock
              key={acc.id || i}
              acc={acc}
              index={i}
              multi={accounts.length > 1}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}

      {/* Acciones */}
      <div className="mt-auto flex items-center gap-1 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => onCopy(cardToText(card), "Ficha completa")}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
        >
          📋 Texto
        </button>
        <button
          type="button"
          onClick={() => onCopyImage(card)}
          title="Copiar la ficha como imagen estilizada"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
        >
          🖼 Imagen
        </button>
        <button
          type="button"
          onClick={() => onEdit(card)}
          className="ml-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
        >
          ✎ Editar
        </button>
        <button
          type="button"
          onClick={() => onDelete(card)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
        >
          🗑
        </button>
      </div>
    </div>
  );
}

// Fila label + valor. TODA la fila es un botón: tap/click copia el valor. Es
// así (en vez de un botón 📋 que aparece con hover) para que funcione en
// móvil, donde no hay hover — el target es el Samsung A56. No renderiza nada
// si el valor está vacío (así las tarjetas no muestran campos en blanco).
function Field({ label, value, copyValue, onCopy, mono = false }) {
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={() => onCopy(copyValue ?? value, label)}
      title={`Copiar ${label}`}
      className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-sm transition-colors hover:bg-[var(--color-accent-soft)] active:bg-[var(--color-accent-soft)]"
    >
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
      <span className={`min-w-0 flex-1 break-words ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
      <span className="shrink-0 text-xs text-[var(--color-muted)]">📋</span>
    </button>
  );
}

// Bloque de una cuenta bancaria con copia por dato y copia del bloque entero.
function AccountBlock({ acc, index, multi, onCopy }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold">
          🏦 {acc.label || (multi ? `Cuenta ${index + 1}` : "Cuenta")}
        </span>
        <button
          type="button"
          onClick={() => onCopy(accountToText(acc), "Cuenta")}
          title="Copiar toda la cuenta"
          className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
        >
          📋 Copiar cuenta
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        <Field label="Titular" value={acc.titular} onCopy={onCopy} />
        <Field label="RUT" value={acc.rutTitular ? formatRutForDisplay(acc.rutTitular) : ""} copyValue={formatRutForDisplay(acc.rutTitular)} onCopy={onCopy} mono />
        <Field label="Banco" value={bankName(acc.bankCode)} onCopy={onCopy} />
        <Field label="Tipo" value={accountTypeLabel(acc.accountType)} onCopy={onCopy} />
        <Field label="N° Cuenta" value={acc.accountNumber} onCopy={onCopy} mono />
        <Field label="Email" value={acc.email} onCopy={onCopy} mono />
      </div>
    </div>
  );
}

// ============================================================
// Tarjeta estilizada para exportar como imagen
// ============================================================
// Render off-screen con estilos inline (html-to-image no siempre resuelve las
// clases Tailwind con variables CSS, así que fijamos colores literales). Ancho
// fijo para que la imagen tenga proporción de "tarjeta".
const IMG_ACCENT = {
  persona: { from: "#2563eb", to: "#1e40af", soft: "#eff6ff", ink: "#1e3a8a" },
  empresa: { from: "#15803d", to: "#166534", soft: "#f0fdf4", ink: "#14532d" },
};

const ContactCardImage = forwardRef(function ContactCardImage({ card }, ref) {
  const meta = TYPE_META[card.type] || TYPE_META.persona;
  const c = IMG_ACCENT[card.type] || IMG_ACCENT.persona;
  const accounts = Array.isArray(card.accounts) ? card.accounts : [];

  const dataRows = [
    card.type === "empresa" && card.giro ? ["Giro", card.giro] : null,
    card.address ? ["Dirección", card.address] : null,
    card.phone ? ["Teléfono", card.phone] : null,
    card.email ? ["Email", card.email] : null,
    card.note ? ["Nota", card.note] : null,
  ].filter(Boolean);

  const rowStyle = { display: "flex", gap: 10, fontSize: 13, lineHeight: 1.4, marginBottom: 4 };
  const labelStyle = { width: 78, flexShrink: 0, color: "#6b7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, paddingTop: 2 };
  const valueStyle = { flex: 1, color: "#111827", wordBreak: "break-word" };

  return (
    <div
      ref={ref}
      style={{
        width: 380,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        background: "#ffffff",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        color: "#111827",
      }}
    >
      {/* Header con gradiente */}
      <div style={{ background: `linear-gradient(135deg, ${c.from}, ${c.to})`, color: "#ffffff", padding: "20px 22px" }}>
        <div style={{ fontSize: 32, lineHeight: 1 }}>{meta.icon}</div>
        <div style={{ fontSize: 21, fontWeight: 700, marginTop: 8, lineHeight: 1.2 }}>{card.name || "(sin nombre)"}</div>
        <div style={{ fontSize: 11, opacity: 0.9, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.6 }}>
          {meta.label}
          {card.rut ? ` · ${formatRutForDisplay(card.rut)}` : ""}
        </div>
      </div>

      {/* Datos */}
      {dataRows.length > 0 && (
        <div style={{ padding: "16px 22px 8px" }}>
          {dataRows.map(([label, value]) => (
            <div key={label} style={rowStyle}>
              <span style={labelStyle}>{label}</span>
              <span style={valueStyle}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Cuentas */}
      {accounts.length > 0 && (
        <div style={{ padding: "4px 22px 16px" }}>
          {accounts.map((acc, i) => (
            <div
              key={acc.id || i}
              style={{ background: c.soft, borderRadius: 10, padding: "10px 12px", marginTop: 10 }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: c.ink, marginBottom: 6 }}>
                🏦 {acc.label || (accounts.length > 1 ? `Cuenta ${i + 1}` : "Cuenta")}
              </div>
              {acc.titular && <ImgAccRow label="Titular" value={acc.titular} />}
              {acc.rutTitular && <ImgAccRow label="RUT" value={formatRutForDisplay(acc.rutTitular)} />}
              <ImgAccRow label="Banco" value={bankName(acc.bankCode)} />
              <ImgAccRow label="Tipo" value={accountTypeLabel(acc.accountType)} />
              {acc.accountNumber && <ImgAccRow label="N° Cuenta" value={acc.accountNumber} strong />}
              {acc.email && <ImgAccRow label="Email" value={acc.email} />}
            </div>
          ))}
        </div>
      )}

      {/* Footer marca */}
      <div style={{ borderTop: "1px solid #f3f4f6", padding: "8px 22px", fontSize: 10, color: "#9ca3af", textAlign: "right" }}>
        🌾 Agrofrutos
      </div>
    </div>
  );
});

function ImgAccRow({ label, value, strong = false }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.4, marginBottom: 2 }}>
      <span style={{ width: 68, flexShrink: 0, color: "#6b7280", fontSize: 10 }}>{label}</span>
      <span style={{ flex: 1, color: "#111827", fontWeight: strong ? 700 : 400, wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

// ============================================================
// Modal de creación / edición
// ============================================================
function ContactCardModal({ initial, onCancel, onSave }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ ...emptyCard(initial.type), ...initial, accounts: (initial.accounts || []).map((a) => ({ ...a })) }));
  const [busy, setBusy] = useState(false);

  const meta = TYPE_META[form.type] || TYPE_META.persona;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const setAccount = (id, patch) =>
    setForm((f) => ({ ...f, accounts: f.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  const addAccount = () => setForm((f) => ({ ...f, accounts: [...f.accounts, emptyAccount()] }));
  const removeAccount = (id) => setForm((f) => ({ ...f, accounts: f.accounts.filter((a) => a.id !== id) }));

  const submit = async () => {
    if (!form.name.trim()) {
      toast.warning(`Ingresá ${meta.nameLabel.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    try {
      await onSave(form);
    } catch (err) {
      toast.error("Error al guardar: " + (err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  const labelCls = "mb-1 block text-xs font-medium text-[var(--color-muted)]";

  return (
    <Modal
      open
      onClose={onCancel}
      size="lg"
      title={form.id ? "Editar ficha" : "Nueva ficha"}
      footer={
        <>
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button onClick={submit} disabled={busy} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Tipo */}
        <div className="flex gap-2">
          {Object.entries(TYPE_META).map(([key, m]) => (
            <button
              key={key}
              type="button"
              onClick={() => set({ type: key })}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                form.type === key
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium"
                  : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
              }`}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {/* Datos generales */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>{meta.nameLabel}</label>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>RUT</label>
            <input value={form.rut} onChange={(e) => set({ rut: e.target.value })} placeholder="12.345.678-9" className={inputCls} />
          </div>
          {form.type === "empresa" && (
            <div>
              <label className={labelCls}>Giro</label>
              <input value={form.giro} onChange={(e) => set({ giro: e.target.value })} className={inputCls} />
            </div>
          )}
          <div>
            <label className={labelCls}>Teléfono</label>
            <input value={form.phone} onChange={(e) => set({ phone: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input value={form.email} onChange={(e) => set({ email: e.target.value })} className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Dirección</label>
            <input value={form.address} onChange={(e) => set({ address: e.target.value })} className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Nota</label>
            <textarea value={form.note} onChange={(e) => set({ note: e.target.value })} rows={2} className={inputCls} />
          </div>
        </div>

        {/* Cuentas bancarias */}
        <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Cuentas bancarias</h3>
            <button type="button" onClick={addAccount} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]">
              + Agregar cuenta
            </button>
          </div>
          {form.accounts.length === 0 && (
            <p className="text-xs text-[var(--color-muted)]">Sin cuentas. Agregá una si querés guardar datos bancarios.</p>
          )}
          {form.accounts.map((acc, i) => (
            <div key={acc.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={acc.label}
                  onChange={(e) => setAccount(acc.id, { label: e.target.value })}
                  placeholder={`Etiqueta (ej. "Cuenta ${i + 1}", "Operaciones")`}
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                />
                <button type="button" onClick={() => removeAccount(acc.id)} title="Eliminar cuenta" className="text-[var(--color-danger)]">✕</button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Titular</label>
                  <input value={acc.titular} onChange={(e) => setAccount(acc.id, { titular: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>RUT titular</label>
                  <input value={acc.rutTitular} onChange={(e) => setAccount(acc.id, { rutTitular: e.target.value })} placeholder="12.345.678-9" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Banco</label>
                  <select value={acc.bankCode} onChange={(e) => setAccount(acc.id, { bankCode: e.target.value })} className={inputCls}>
                    {BANKS.map((b) => (
                      <option key={b.code} value={b.code}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Tipo de cuenta</label>
                  <select value={acc.accountType} onChange={(e) => setAccount(acc.id, { accountType: Number(e.target.value) })} className={inputCls}>
                    {ACCOUNT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>N° de cuenta</label>
                  <input value={acc.accountNumber} onChange={(e) => setAccount(acc.id, { accountNumber: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Email (opcional)</label>
                  <input value={acc.email} onChange={(e) => setAccount(acc.id, { email: e.target.value })} className={inputCls} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
