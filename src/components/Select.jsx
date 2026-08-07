export default function Select({ label, value, onChange, options, required = false, placeholder = "Selecciona...", disabled = false }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block text-sm text-[var(--color-muted)]">
          {label}
          {required && <span className="ml-0.5 text-[var(--color-danger)]">*</span>}
        </span>
      )}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
