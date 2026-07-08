import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

const AuthContext = createContext(null);

const ROLES = { ADMIN: "admin", SUPERVISOR: "supervisor" };

async function loadProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    // Normalizamos `role` a minúsculas — históricamente algunos docs quedaron
    // con "ADMIN"/"Admin" y la comparación contra ROLES.ADMIN ("admin") fallaba
    // silenciosamente. `toLowerCase` acá lo resuelve para todos los usuarios
    // sin tener que reescribir los docs.
    const role = String(data.role || ROLES.SUPERVISOR).toLowerCase();
    return { uid: user.uid, email: user.email, ...data, role };
  }
  return { uid: user.uid, email: user.email, role: ROLES.SUPERVISOR };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const profile = await loadProfile(fbUser);
          setUser(profile);
        } catch (e) {
          console.error("Failed to load profile", e);
          setUser({ uid: fbUser.uid, email: fbUser.email, role: ROLES.SUPERVISOR });
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
  }, []);

  const login = (email, password) => signInWithEmailAndPassword(auth, email, password);
  const logout = () => signOut(auth);

  const isAdmin = user?.role === ROLES.ADMIN;

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export { ROLES };
