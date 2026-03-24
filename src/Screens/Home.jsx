import { useState, useEffect } from "react";
import { getData } from "../Components/getData";

export default function Home() {
  const [data, setData] = useState({ allDates: [], dataTable: [] });
  const [sortColumn, setSortColumn] = useState({ key: null, direction: "asc"});

  function handleSort(key) {
    let direction = "asc";
    if (sortColumn.key === key && sortColumn.direction === "asc") {
      direction = "desc";
    }

    setSortColumn({ key, direction });
  }

  const sortedData = [...data.dataTable].sort((a, b) => {
    if (!sortColumn.key) return 0;

    const aValue = a[sortColumn.key] ?? 0;
    const bValue = b[sortColumn.key] ?? 0;

    if (aValue < bValue) return sortColumn.direction === "asc" ? -1 : 1;
    if (aValue > bValue) return sortColumn.direction === "asc" ? 1 : -1;
    return 0;
  });

  // Obtencion de Tabla
  useEffect(() => {
    async function fetchData() {
      const result = await getData();
      // cambiar direccion de columnas
      result.allDates.reverse();
      result.dataTable.reverse();
      setData(result);
    }
    fetchData();
  }, []);


  return (
    <div>
      <h2>Pantalla Principal</h2>

      {/* Tabla de datos */}
      <table border="1" style={{ marginTop: "20px", width: "100%" }}>
        <thead>
          <tr>
            <th onClick={() => handleSort("rut")}>RUT</th>
            <th onClick={() => handleSort("name")}>Nombre</th>
            <th onClick={() => handleSort("idQr")}>ID QR</th>
            {data.allDates.map((date) => (
              <th key={date} onClick={() => handleSort(date)}>{date}</th>
            ))}
            <th onClick={() => handleSort("total")}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item, index) => (
            <tr key={index}>
              <td>{item.rut}</td>
              <td>{item.name}</td>
              <td>{item.idQr?.[0]}</td>
              {data.allDates.map((date) => (
                <td key={date}>{item[date]?.toFixed(2) || 0}</td>
              ))}
              <td>{item["total"]?.toFixed(2) || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}