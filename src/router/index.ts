import { createElement, useEffect } from "react";
import { createBrowserRouter, Outlet, useNavigate, type NavigateFunction } from "react-router-dom";
import routes from "./config";

let navigateResolver: (navigate: ReturnType<typeof useNavigate>) => void;

declare global {
  interface Window {
    REACT_APP_NAVIGATE: ReturnType<typeof useNavigate>;
  }
}

export const navigatePromise = new Promise<NavigateFunction>((resolve) => {
  navigateResolver = resolve;
});

// Layout route that keeps the existing window.REACT_APP_NAVIGATE hook working.
function RouterShell() {
  const navigate = useNavigate();
  useEffect(() => {
    window.REACT_APP_NAVIGATE = navigate;
    navigateResolver(window.REACT_APP_NAVIGATE);
  });
  return createElement(Outlet);
}

/**
 * A data router (not <BrowserRouter>), because only a data router provides useBlocker: that is what lets the CMS warn about unsaved
 * changes on the browser Back/Forward buttons and on programmatic navigation, not just on link clicks.
 */
export const appRouter = createBrowserRouter([{ element: createElement(RouterShell), children: routes }], { basename: __BASE_PATH__ });
