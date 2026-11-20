import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const rootEl = document.getElementById("root");

function rendre(): void {
  if (!rootEl) return;
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Build du bureau seulement (constante remplacée au build : le build web n'embarque pas l'amorce).
if (import.meta.env.MODE === "bureau-interface") {
  import("./desktop/amorce.ts")
    .then(({ amorcer }) => amorcer(rendre))
    .catch((error: unknown) => {
      if (rootEl) rootEl.textContent = `Grammaria n'a pas pu démarrer : ${String(error)}`;
    });
} else {
  rendre();
}
