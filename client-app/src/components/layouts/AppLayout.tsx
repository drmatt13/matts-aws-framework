import type { ReactNode } from "react";

interface AppLayoutProps {
  children: ReactNode;
}

const AppLayout = ({ children }: AppLayoutProps) => {
  return (
    <div className="app-stage font-sans">
      <div className="mx-auto w-full max-w-3xl px-6 py-14 sm:py-20">
        {children}
      </div>
    </div>
  );
};

export default AppLayout;
