export default function Dashboard() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-[var(--color-muted)]">Resumen general del sistema.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {["Faenas activas", "Cosechas en curso", "Trabajadores"].map((label) => (
          <div
            key={label}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="text-sm text-[var(--color-muted)]">{label}</div>
            <div className="mt-2 text-2xl font-semibold">—</div>
          </div>
        ))}
      </div>
    </div>
  );
}
