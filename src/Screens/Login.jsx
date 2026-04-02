import { useState, useEffect } from "react";

export default function Login({ signIn }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");


  const handleSubmit = (e) => {
    e.preventDefault();
    if (user === "admin" && password === "admin123") {
      setError("");
      signIn(user);
    } else {
      setError("Usuario o contraseña incorrectos");
    }
  };

  useEffect(() => {
    const savedUser = localStorage.getItem("user");
    if (savedUser) {
      signIn(savedUser);
    }
  }, []);


  return (
    <div >
      <h2>Login</h2>
      <form onSubmit={handleSubmit}>

        <input
          type="text"
          placeholder="Usuario"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />

        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        
        <button type="submit" disabled={!user || !password}>Entrar</button>
      </form>
      
      {error && <p style={{ color: "red" }}>{error}</p>}

    </div>
  );
}