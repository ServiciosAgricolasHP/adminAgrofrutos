import { collection, getDocs, query, where, orderBy, limit  } from "firebase/firestore";
import { db } from "../../firebase";

export async function getData(startDate, endDate) {

  const workerRef = collection(db, "worker");
  const workerSnap = await getDocs(workerRef);

  // Informacion de Todos los workers
  const workersData = {};
  workerSnap.forEach((docSnap) => {
    const workerInfo = docSnap.data();
    workersData[workerInfo.idQr[0]] = {
      rut: docSnap.id,
      name: workerInfo.name,
      idQr: workerInfo.idQr,
    };
  });

  // Data de pesajes

  const weightRef = collection(db, "weights");
  const weekWeights = query(weightRef,  where("__name__", ">=", startDate), 
                                        where("__name__", "<=", endDate),
                                        orderBy("__name__", "desc"));
                                        
  const weightSnap = await getDocs(weekWeights);

  // Guardar fechas
  const allDates = weightSnap.docs.map(doc => doc.id);
  const totalWeights = {};

  const promises = weightSnap.docs.map(async (docSnap) => {
    
    const date = docSnap.id;
    console.log("la fecha es :", date)

    const dayWeights = await getDocs(query(collection(db, "weights", date, "entry"), orderBy("idQr", "desc")));
    console.log("aqui es: ", dayWeights)
    dayWeights.forEach((doc) => {
          
      const data = doc.data();
      const { idQr, amount } = data;

      const worker = workersData[idQr];

      if (!worker) return;
      const rut = worker.rut;

      // Inicializar fila si no existe
      if (!totalWeights[rut]) {
        totalWeights[rut] = {
        rut: worker.rut,
        name: worker.name,
          idQr: worker.idQr,
        };
      }

         // Inicializar columnas de fecha si no existe, no funciona sin inicizalizarla
      if (!totalWeights[rut][date]) {
        totalWeights[rut][date] = 0;
      }
      if (!totalWeights[rut]["total"]) {
        totalWeights[rut]["total"] = 0;
      }

       totalWeights[rut][date] += amount;
       totalWeights[rut]["total"] += amount;
      }
    );
  });

  await Promise.all(promises);
  
  const dataTable = Object.values(totalWeights);

  console.log("Tabla de resultados:", dataTable);
  return { allDates, dataTable };
}