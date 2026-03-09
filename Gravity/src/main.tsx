import React from "react";
import ReactDOM from "react-dom/client";
import "./tailwind.css";
import App from "./App";
import {
  beginStartupDiagnostics,
  exposeStartupDiagnostics,
  installStartupErrorHandlers,
  recordStartupEvent,
} from "./state/startupDiagnostics";

const backdropFilterSupported =
  typeof CSS !== "undefined" &&
  (CSS.supports("backdrop-filter: blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter: blur(1px)"));

beginStartupDiagnostics({
  backdropFilterSupported,
  viewportHeight: window.innerHeight,
  viewportWidth: window.innerWidth,
});
installStartupErrorHandlers();
exposeStartupDiagnostics();

const rootElement = document.getElementById("root");
recordStartupEvent("boot.root.lookup", { found: Boolean(rootElement) });

if (!rootElement) {
  throw new Error("React root element was not found.");
}

const root = ReactDOM.createRoot(rootElement);
recordStartupEvent("boot.react.root-created");

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
recordStartupEvent("boot.react.render-called");
