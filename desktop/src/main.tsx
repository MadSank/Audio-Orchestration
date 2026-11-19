import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable and offline: the service worker keeps the app's own files (never the music).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("sw.js");
}
