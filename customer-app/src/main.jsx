import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Registers the service worker that powers local ("mock") order-status
// notifications — see notifyOrderStatusChange in App.jsx. Safe to skip
// silently on browsers/contexts without service worker support (e.g. non-
// HTTPS dev origins other than localhost).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
