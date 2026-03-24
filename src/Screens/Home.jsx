import { useState, useEffect } from "react";
import { getData } from "../Components/getData";

export default function Home() {
  // Tabla
  const [data, setData] = useState({ allDates: [], dataTable: [] });
  // Orden asc/desc en las columnas
  const [sortColumn, setSortColumn] = useState({ key: null, direction: "asc"});
  // Filtro/Busqueda
  const [filters, setFilters] = useState({rut: "", name: "",  idQr: ""});

  function handleSort(key) {
    let direction = "asc";
    if (sortColumn.key === key && sortColumn.direction === "asc") {
      direction = "desc";
    }

    setSortColumn({ key, direction });
  }

  // Filtro dependiendo RUT o nombre
  const filteredData = data.dataTable.filter((item) => {
    const rutFilter = item.rut
      ?.toLowerCase()
      .includes(filters.rut.toLowerCase());

    const nameFilter = item.name
      ?.toLowerCase()
      .includes(filters.name.toLowerCase());

    const idqrFilter = item.idQr?.[0]
      ?.toLowerCase()
      .includes(filters.idQr.toLowerCase());

    return rutFilter && nameFilter && idqrFilter;
  });

  // Ordenar dataTable
  const sortedData = [...filteredData].sort((a, b) => {
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

      <input
        type="text"
        placeholder="RUT"
        value={filters.rut}
        onChange={(e) =>
          setFilters({ ...filters, rut: e.target.value })
        }
      />

      <input
        type="text"
        placeholder="Nombre"
        value={filters.name}
        onChange={(e) =>
          setFilters({ ...filters, name: e.target.value })
        }
      />

      <input
        type="text"
        placeholder="IdQr"
        value={filters.idQr}
        onChange={(e) =>
          setFilters({ ...filters, idQr: e.target.value })
        }
      />

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