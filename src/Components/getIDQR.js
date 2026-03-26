import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";

export async function getIDQR() {
  const workerRef = collection(db, "worker");
  const snapshot = await getDocs(workerRef);

  const allPrefix = new Set();

  snapshot.forEach((doc) => {
    const data = doc.data();
    const idqrPrefix = data.idQr?.[0]?.split("-")[0];
    if (idqrPrefix) {
      allPrefix.add(idqrPrefix);
    }
  });

  return Array.from(allPrefix);
}