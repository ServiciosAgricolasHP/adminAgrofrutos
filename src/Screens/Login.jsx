import { useState } from "react";

export default function Login({ signIn }) {
  const [email, setEmail] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    signIn(email);
  };

  return (
    <div >
      <h2>Login</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Ingresa tu correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit">Entrar</button>
      </form>
    </div>
  );
}