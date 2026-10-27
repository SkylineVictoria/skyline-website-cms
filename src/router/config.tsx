import { Navigate } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import SiteLayout from "@/components/feature/SiteLayout";
import Home from "@/pages/home/page";
import ContentPageRoute from "@/pages/content/page";
import CmsPageRoute from "@/pages/content/CmsPageRoute";
import CoursesPage from "@/pages/courses/page";
import CourseDetailPage from "@/pages/course-detail/page";
import ContactPage from "@/pages/contact/page";
import EnrollPage from "@/pages/enroll/page";
import BecomeAnAgentPage from "@/pages/become-an-agent/page";
import AgentsPage from "@/pages/agents/page";
import FormsPoliciesPage from "@/pages/forms-policies/page";
import CmsFormPage from "@/pages/form/page";
import { contentPages } from "@/data/pages";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";

import PortalProviders from "@/pages/agency/components/PortalProviders";
import PortalLanding from "@/pages/agency/components/PortalLanding";
import RequirePortal from "@/pages/agency/components/RequirePortal";
import LoginPage from "@/pages/login/page";
import LoginRedirect from "@/pages/login/LoginRedirect";
import PortalDashboardPage from "@/pages/agency/dashboard/page";
import PortalApplicationsPage from "@/pages/agency/applications/page";
import NewApplicationPage from "@/pages/agency/applications/new/page";
import ApplicationDetailPage from "@/pages/agency/applications/detail/page";
import PortalDocumentsPage from "@/pages/agency/documents/page";
import PortalNotificationsPage from "@/pages/agency/notifications/page";
import AgencyProfilePage from "@/pages/agency/agency-profile/page";
import PortalProfilePage from "@/pages/agency/profile/page";
import AdminAgenciesPage from "@/pages/agency/agencies/page";
import AdminUsersPage from "@/pages/agency/users/page";
import AllApplicationsPage from "@/pages/agency/all-applications/page";
import AdminAuditLogPage from "@/pages/agency/audit-log/page";
import RegistrationWorkbenchPage from "@/pages/agency/registrations/page";

import AdminProviders from "@/pages/admin/components/AdminProviders";
import AdminLayout from "@/pages/admin/components/AdminLayout";
import RequireAdmin from "@/pages/admin/components/RequireAdmin";
import AdminSetPasswordPage from "@/pages/admin/SetPasswordPage";
import DashboardPage from "@/pages/admin/DashboardPage";
import AdminCoursesPage from "@/pages/admin/CoursesPage";
import CourseEditorPage from "@/pages/admin/CourseEditorPage";
import AdminPagesPage from "@/pages/admin/PagesPage";
import NavigationPage from "@/pages/admin/NavigationPage";
import FooterPage from "@/pages/admin/FooterPage";
import SettingsPage from "@/pages/admin/SettingsPage";
import DocumentsPage from "@/pages/admin/DocumentsPage";
import AdminFormsPage from "@/pages/admin/FormsPage";
import FormBuilderPage from "@/pages/admin/FormBuilderPage";
import AdminContactPage from "@/pages/admin/ContactPage";
import AdminSeoPage from "@/pages/admin/SeoPage";
import UsersPage from "@/pages/admin/UsersPage";
import InstitutionPage from "@/pages/admin/InstitutionPage";
import ActivityPage from "@/pages/admin/ActivityPage";
import KnowledgePage from "@/pages/admin/KnowledgePage";
import DocumentIndexPage from "@/pages/admin/DocumentIndexPage";

const routes: RouteObject[] = [
  {
    path: "/",
    element: <SiteLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "about-us", element: <ContentPageRoute data={contentPages["about-us"]} /> },
      { path: "our-courses", element: <CoursesPage /> },
      { path: "courses/:slug", element: <CourseDetailPage /> },
      { path: "information", element: <ContentPageRoute data={contentPages.information} /> },
      { path: "student-visa", element: <ContentPageRoute data={contentPages["student-visa"]} /> },
      { path: "oshc", element: <ContentPageRoute data={contentPages.oshc} /> },
      { path: "forms-policies", element: <FormsPoliciesPage /> },
      { path: "forms/:id", element: <CmsFormPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "become-an-agent", element: <BecomeAnAgentPage /> },
      { path: "contact", element: <ContactPage /> },
      { path: "enroll-now", element: <EnrollPage /> },
      { path: "*", element: <CmsPageRoute /> },
    ],
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/forgot-password",
    element: <ForgotPasswordPage />,
  },
  {
    path: "/reset-password",
    element: <ResetPasswordPage />,
  },
  {
    path: "/agency",
    element: <PortalProviders />,
    children: [
      { path: "login", element: <LoginRedirect /> },
      {
        element: <RequirePortal />,
        children: [
          { index: true, element: <PortalLanding /> },
          { path: "dashboard", element: <PortalDashboardPage /> },
          { path: "applications", element: <PortalApplicationsPage /> },
          { path: "applications/new", element: <NewApplicationPage /> },
          { path: "applications/:id", element: <ApplicationDetailPage /> },
          { path: "documents", element: <PortalDocumentsPage /> },
          { path: "notifications", element: <PortalNotificationsPage /> },
          { path: "agency-profile", element: <AgencyProfilePage /> },
          { path: "profile", element: <PortalProfilePage /> },
          { path: "agencies", element: <AdminAgenciesPage /> },
          { path: "users", element: <AdminUsersPage /> },
          { path: "all-applications", element: <AllApplicationsPage /> },
          { path: "audit-log", element: <AdminAuditLogPage /> },
          { path: "registrations", element: <RegistrationWorkbenchPage /> },
        ],
      },
    ],
  },
  {
    path: "/admin",
    element: <AdminProviders />,
    children: [
      { path: "login", element: <LoginRedirect /> },
      { path: "set-password", element: <AdminSetPasswordPage /> },
      {
        element: <AdminLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "courses", element: <AdminCoursesPage /> },
          { path: "courses/:slug", element: <CourseEditorPage /> },
          { path: "pages", element: <AdminPagesPage /> },
          { path: "navigation", element: <NavigationPage /> },
          { path: "footer", element: <FooterPage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "documents", element: <DocumentsPage /> },
          { path: "forms", element: <AdminFormsPage /> },
          { path: "forms/:id", element: <FormBuilderPage /> },
          { path: "contact", element: <AdminContactPage /> },
          { path: "seo", element: <AdminSeoPage /> },
          { path: "users", element: <RequireAdmin><UsersPage /></RequireAdmin> },
          { path: "institution", element: <RequireAdmin><InstitutionPage /></RequireAdmin> },
          { path: "activity", element: <ActivityPage /> },
          { path: "knowledge", element: <RequireAdmin><KnowledgePage /></RequireAdmin> },
          { path: "knowledge/documents", element: <RequireAdmin><DocumentIndexPage /></RequireAdmin> },
        ],
      },
    ],
  },
];

export default routes;
