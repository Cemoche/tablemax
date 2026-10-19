import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled data font (OFL, license shipped as licenses/JetBrainsMono-OFL.txt, see
// vite.config.ts): regular and medium, Latin subsets only. Nothing loads from the network.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-ext-500.css";
import "./index.css";
import { useSettings } from "./stores/settings";

// Applies the saved theme as early as possible; the defaults render meanwhile.
void useSettings.getState().load();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
