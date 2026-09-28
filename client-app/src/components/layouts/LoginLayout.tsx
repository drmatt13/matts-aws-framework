import type { ReactNode } from "react";
import { Boxes } from "lucide-react";

/** The only product copy the auth shell owns. Swap it, swap the icon, done. */
export const APP_NAME = "matt's-aws-framework";

interface LoginLayoutProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Cross-link rendered under the card, e.g. "Don't have an account?". */
  footer?: ReactNode;
}

// Owns the gradient stage, the brand mark, the card and its heading, so every
// auth route below is just its own fields.
const LoginLayout = ({
  title,
  subtitle,
  children,
  footer,
}: LoginLayoutProps) => {
  return (
    <main className="auth-stage font-sans">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-linear-to-br from-brand to-brand-2 text-white shadow-sm">
          <Boxes className="size-5" />
        </span>
        <span className="text-[0.95rem] font-semibold tracking-tight">
          {APP_NAME}
        </span>
      </div>

      <div className="w-full max-w-md">
        <section className="auth-card">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          {children}
        </section>

        {footer && (
          <p className="mt-5 text-center text-sm text-muted">{footer}</p>
        )}
      </div>
    </main>
  );
};

export default LoginLayout;
