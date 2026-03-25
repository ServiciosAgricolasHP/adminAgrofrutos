
export function FilterBox({ show, value, onChange, placeholder }) {
  if (!show) return null;

  return (
    <div
      style={{
        position: "absolute",
        background: "white",
        border: "1px solid #ccc",
        padding: "8px",
        borderRadius: "6px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        zIndex: 10,
      }}
    >
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={{ width: "150px" }}
      />
    </div>
  );
}