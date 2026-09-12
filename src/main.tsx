import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RequestProgress } from "./components/Loading";
import "./styles.css";
import "./auth.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RequestProgress />
    <App />
  </React.StrictMode>,
);
