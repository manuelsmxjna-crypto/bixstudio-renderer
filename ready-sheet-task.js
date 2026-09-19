export function buildReadySheetHttpRequest({ baseUrl, serviceAccountEmail, bodyText, signature }) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BIX_RENDERER_PUBLIC_URL debe ser la URL HTTPS raíz del servicio de pruebas.");
  }
  if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(serviceAccountEmail || "")) {
    throw new Error("Configura READY_SHEET_TASK_SERVICE_ACCOUNT con una cuenta de servicio válida.");
  }
  return {
    httpMethod: "POST",
    url: `${url.origin}/ready-sheets/worker`,
    headers: {
      "Content-Type": "application/json",
      "X-BixStudio-Task-Signature": signature
    },
    body: Buffer.from(bodyText).toString("base64"),
    oidcToken: {
      serviceAccountEmail,
      audience: url.origin
    }
  };
}
