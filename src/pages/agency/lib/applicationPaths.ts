import { createContext, useContext } from "react";

/** Where the application list, detail and new-application pages live: the agency portal, or the CMS for administrators. */
export interface ApplicationPaths {
  area: "portal" | "cms";
  list: string;
  create: string;
  detail: (id: string) => string;
}

export const portalPaths: ApplicationPaths = {
  area: "portal",
  list: "/agency/applications",
  create: "/agency/applications/new",
  detail: (id) => `/agency/applications/${id}`,
};

export const cmsPaths: ApplicationPaths = {
  area: "cms",
  list: "/admin/applications",
  create: "/admin/applications/new",
  detail: (id) => `/admin/applications/${id}`,
};

export const ApplicationPathsContext = createContext<ApplicationPaths>(portalPaths);

export function useApplicationPaths(): ApplicationPaths {
  return useContext(ApplicationPathsContext);
}
