import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useSettings } from "./stores/settings";

// Applies the saved theme as early as possible; the defaults render meanwhile.
void useSettings.getState().load();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
