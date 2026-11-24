import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PrivateRemoteDev } from "./windows/PrivateRemoteDev";
import "./windows/privateRemoteDev.css";
import "./layout.css";

const privateRemoteDev =
  (window as Window & { __AERIFT_PRIVATE_REMOTE_DEV__?: boolean }).__AERIFT_PRIVATE_REMOTE_DEV__ === true;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {privateRemoteDev ? <PrivateRemoteDev /> : <App />}
  </StrictMode>,
);
