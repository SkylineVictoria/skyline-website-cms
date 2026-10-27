import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { appRouter } from "./router";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";


function App() {
  // Retire the pre-React loader (index.html #boot) once the app has mounted, with a short fade.
  useEffect(() => {
    const boot = document.getElementById("boot");
    if (!boot) return undefined;
    boot.classList.add("boot-hide");
    const timer = window.setTimeout(() => boot.remove(), 350);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={appRouter} />
    </I18nextProvider>
  );
}

export default App;
