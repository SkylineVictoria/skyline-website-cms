import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** The plain page around the public booking screens (no menu; works signed out). */
export default function BookingShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8">
      <div className={`mx-auto ${wide ? "max-w-5xl" : "max-w-2xl"}`}>
        <p className="mb-4 text-sm font-semibold text-primary-700"><Link to="/">Skyline Institute of Technology</Link> <span className="font-normal text-foreground-500">· Bookings</span></p>
        {children}
      </div>
    </div>
  );
}
