import { useState, useEffect } from "react";
import { getData } from "../Components/getData";

export default function Home() {
  const [text, setText] = useState("");
  const [data, setData] = useState({ allDates: [], dataTable: [] });

  useEffect(() => {
    async function fetchData() {
      const result = await getData();
      setData(result);
    }
    fetchData();
  }, []);

  return (
    <div>
      <h2>Pantalla Principal</h2>
      <input
        type="text"
        placeholder="Escribe algo..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p>Tu texto: {text}</p>

      {/* Tabla de datos */}
      <table border="1" style={{ marginTop: "20px", width: "100%" }}>
        <thead>
          <tr>
            <th>RUT</th>
            <th>Nombre</th>
            <th>ID QR</th>
            {data.allDates.map((date) => (
              <th key={date}>{date}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.dataTable.map((item, index) => (
            <tr key={index}>
              <td>{item.rut}</td>
              <td>{item.name}</td>
              <td>{item.idQr?.[0]}</td>
              {data.allDates.map((date) => (
                <td key={date}>{item[date]?.toFixed(2) || 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}