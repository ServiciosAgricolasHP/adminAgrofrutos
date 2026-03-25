import { useState, useEffect } from "react";
import { getData } from "../Components/getData";
import { FilterBox } from "../Utils/popupFilter";


export default function Home() {

  // Tabla
  const [data, setData] = useState({ allDates: [], dataTable: [] });
  const [dateRange, setDateRange] = useState({startDate: "", endDate: ""});

  // Orden asc/desc en las columnas
  const [sortColumn, setSortColumn] = useState({ key: null, direction: "asc"});
  
  // Filtro/Busqueda
  const [showFilters, setShowFilters] = useState({rut: false, name: false, idQr: false});
  const [filters, setFilters] = useState({rut: "", name: "",  idQr: ""});
  const [selectedID, setSelectedID] = useState("");

  function handleSort(key) {
    let direction = "asc";
    if (sortColumn.key === key && sortColumn.direction === "asc") {
      direction = "desc";
    }

    setSortColumn({ key, direction });
  }


  // IDQRs disponibles
  const idQrPrefixes = [
    ...new Set(
      data.dataTable
        .map(item => item.idQr?.[0]?.split("-")[0])
        .filter(Boolean)
    )
  ];

  // Filtro dependiendo RUT o nombre / CAMBIAR IDQR P
  const filteredData = data.dataTable.filter((item) => {
    const rutFilter = item.rut
      ?.toLowerCase()
      .includes(filters.rut.toLowerCase());

    const nameFilter = item.name
      ?.toLowerCase()
      .includes(filters.name.toLowerCase());

    const prefix = item.idQr?.[0]?.split("-")[0];
    const prefixFilter = selectedID
      ? prefix === selectedID
      : true;

    return rutFilter && nameFilter && prefixFilter;
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
  
  async function obtainData(startDate = null, endDate = null) {
      const result = await getData(startDate, endDate);
      // cambiar direccion de columnas
      result.allDates.reverse();
      result.dataTable.reverse();
      setData(result);
  }

  useEffect(() => {
    obtainData();
  }, []);


  return (
    <div>

      <div style={{ marginBottom: "10px" }}>
        {idQrPrefixes.map((prefix) => (
          <button
            key={prefix}
            onClick={() => setSelectedID(prefix)}
            style={{
              marginLeft: "5px",
              background: selectedID === prefix ? "#ccc" : "#fff"
            }}
          >
            {prefix}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: "20px" }}>
        <label>
          {"Fecha de Inicio: "}
          <input
            type="date"
            value={dateRange.startDate}
            onChange={(e) =>
              setDateRange({ ...dateRange, startDate: e.target.value })
            }
          />
        </label>

        <label style={{ marginLeft: "10px" }}>
          {"Fecha de Finalización: "}
          <input
            type="date"
            value={dateRange.endDate}
            onChange={(e) =>
              setDateRange({ ...dateRange, endDate: e.target.value })
            }
          />
        </label>

        <button
          style={{ marginLeft: "10px" }}
          disabled={!dateRange.startDate || !dateRange.endDate}
          onClick={() => obtainData(dateRange.startDate, dateRange.endDate)}
        >
          Crear ciclo
        </button>
      </div>

      <h2>Total de trabajadores en la semana: {filteredData.length}</h2>
      <h2>Total planilla: {filteredData.reduce((totalAdquire, item) => totalAdquire + (item.total || 0), 0)?.toFixed(2) || 0}</h2> 
      <h2>Promedio por trabajador: {(filteredData.reduce((totalAdquire, item) => totalAdquire + (item.total || 0), 0) / filteredData.length)?.toFixed(2)  || 0}</h2> 


      {/* Tabla de datos */}
      <div style={{ maxHeight: "400px", maxWidth: "900px", overflowY: "auto"}}>
        <table border="1" style={{ marginTop: "20px", width: "100%" }}>
          <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}> 
            <tr>

              <th style={{ position: "relative" }} onClick={() => handleSort("rut")}> RUT
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFilters({...showFilters, rut: !showFilters.rut});
                  }}
                > + </button>

                <FilterBox
                    show={showFilters.rut}
                    value={filters.rut}
                    onChange={(e) =>
                      setFilters({ ...filters, rut: e.target.value })
                    }
                    placeholder="Filtrar RUT"
                  />
              </th>

              <th onClick={() => handleSort("name")}> Nombre
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFilters({...showFilters, name: !showFilters.name});
                  }}
                > + </button>

                <FilterBox
                    show={showFilters.name}
                    value={filters.name}
                    onChange={(e) =>
                      setFilters({ ...filters, name: e.target.value })
                    }
                    placeholder="Filtrar Nombre"
                  />

              </th>
              
              <th onClick={() => handleSort("idQr")}> ID QR
              </th>

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
    </div>
  );
}