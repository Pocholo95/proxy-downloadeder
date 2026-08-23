import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { releaseAll } from "@/lib/blobCache";
import "./style.css";

// Clean up all blob URLs on page unload to prevent memory leaks
window.addEventListener("beforeunload", releaseAll);

ReactDOM.createRoot(document.getElementById("app")!).render(
  <React.StrictMode>
    <div id="app-shell" className="app-shell">
      <App />
    </div>
  </React.StrictMode>,
);
