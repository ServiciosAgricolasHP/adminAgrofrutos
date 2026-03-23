import { useState } from 'react'
import './App.css'
import Login from "./Screens/Login";
import Home from "./Screens/Home";


function App() {
  const [user, setUser] = useState(null);

  return (
    <>
      {user ? (
        <Home />
      ) : (
        <Login signIn={(email) => setUser(email)} />
      )}
    </>
  );

}

export default App
