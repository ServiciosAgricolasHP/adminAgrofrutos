import { useState, useEffect, useMemo } from "react";
import { getData, getIDQR } from "../Components";
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
  const [allIdqrs, setAllIdqrs] = useState([]);
  const [selectedID, setSelectedID] = useState("");

  // Ciclos Guardados
  const [savedRanges, setSavedRanges] = useState([]);
  const [selectedRange, setSelectedRange] = useState("");

  function handleSort(key) {
    let direction = "asc";
    if (sortColumn.key === key && sortColumn.direction === "asc") {
      direction = "desc";
    }

    setSortColumn({ key, direction });
  }


  // Filtro dependiendo RUT o nombre / CAMBIAR IDQR P
  const filteredData = useMemo(() => {
    return data.dataTable.filter((item) => {
      const rutFilter = item.rut?.toLowerCase().includes(filters.rut.toLowerCase());
      const nameFilter = item.name?.toLowerCase().includes(filters.name.toLowerCase());

      const prefix = item.idQr?.[0]?.split("-")[0];
      const prefixFilter = selectedID ? prefix === selectedID : true;

      return rutFilter && nameFilter && prefixFilter;
    });
  }, [data.dataTable, filters, selectedID]);

  // Ordenar dataTable / useMemo para no recalcular render
  const sortedData = useMemo(() => {
    if (!sortColumn.key) return filteredData;

    return [...filteredData].sort((a, b) => {
      const aValue = a[sortColumn.key] ?? 0;
      const bValue = b[sortColumn.key] ?? 0;

      if (aValue < bValue) return sortColumn.direction === "asc" ? -1 : 1;
      if (aValue > bValue) return sortColumn.direction === "asc" ? 1 : -1;
      return 0;
    });
  }, [filteredData, sortColumn]);

  // Obtencion de Tabla / useMemo para no recalcular render
  async function obtainData(startDate = null, endDate = null) {
      const result = await getData(startDate, endDate);
      // cambiar direccion de columnas
      result.allDates.reverse();
      result.dataTable.reverse();
      setData(result);
  }

  useEffect(() => {
      // IDQRs disponibles
    async function loadPrefixes() {
        const allIdqr = await getIDQR();
        setAllIdqrs(allIdqr);
      }
      loadPrefixes();
    obtainData();

  }, []);


  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside style={{width: "200px", padding: "10px"}}>
        <h2>Sistema de Gestión</h2>
        <div>
          {allIdqrs.map((prefix) => (
            <button
              key={prefix}
              onClick={() => setSelectedID(prefix)}
              style={{
                marginBottom: "10px",
                width: "100%",
                padding: "20px",
                fontSize: "16px",
                borderRadius: "14px",
                cursor: "pointer",
                border: "none",
                minWidth: "200px",
                background: selectedID === prefix ? "#ccc" : "#fff"
              }}
            >
              {prefix}
            </button>
          ))}
        </div>
      </aside >
      
      <select
        value={selectedRange}
        onChange={(e) => {
          const index = e.target.value;
          setSelectedRange(index);

          const range = savedRanges[index];
          if (range) {
            setDateRange({
              startDate: range.startDate,
              endDate: range.endDate
            });

            obtainData(range.startDate, range.endDate);
          }
        }}
        style={{ marginRight: "10px", height: "20px"}}
      >
        <option value="">Seleccionar ciclo</option>
        {savedRanges.map((range, index) => (
          <option key={index} value={index}>
            {range.name}
          </option>
        ))}
      </select>

      <div style={{ flex: 1}}>
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
            onClick={() => {
              const newRange = {
                name: `Fecha ${dateRange.startDate} / ${dateRange.endDate}`,
                startDate: dateRange.startDate,
                endDate: dateRange.endDate
              };
              
              setSavedRanges((prev) => [...prev, newRange]);
              obtainData(dateRange.startDate, dateRange.endDate);
            }}
          >
            Crear ciclo
          </button>
        </div>

        <div style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}> 
          <h2>Total de trabajadores en la semana: {filteredData.length}</h2>
          <h2>Total planilla: {filteredData.reduce((totalAdquire, item) => totalAdquire + (item.total || 0), 0)?.toFixed(2) || 0}</h2> 
          <h2>Promedio por trabajador: {(filteredData.reduce((totalAdquire, item) => totalAdquire + (item.total || 0), 0) / filteredData.length)?.toFixed(2)  || 0}</h2> 
        </div>

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
              {sortedData.map((item) => (
                <tr key={item.rut}>
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
    </div>
  );
}