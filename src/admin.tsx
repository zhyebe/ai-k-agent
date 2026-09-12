import React from "react";
import ReactDOM from "react-dom/client";
import AdminApp from "./AdminApp";
import { RequestProgress } from "./components/Loading";
import "./styles.css";
import "./admin.css";

ReactDOM.createRoot(document.getElementById("admin-root")!).render(
  <React.StrictMode>
    <RequestProgress />
    <AdminApp />
  </React.StrictMode>,
);
