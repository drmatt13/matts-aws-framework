import type { ReactElement } from "react";
import type { SsoProviderId } from "#/lib/auth";

export type SsoProviderUi = {
  id: SsoProviderId;
  /** Bare provider name, interpolated into notice/error copy. */
  name: string;
  label: string;
  Icon: () => ReactElement;
};

function GoogleIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 18 18">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.94v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.94A9 9 0 0 0 0 9c0 1.45.34 2.82.94 4.05l3.02-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.43 1.34l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .94 4.95l3.02 2.33C4.67 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

function AppleIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 shrink-0 fill-current"
      viewBox="0 0 24 24"
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702" />
    </svg>
  );
}

function MicrosoftIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const SSO_PROVIDER_UI_CONFIG: Record<SsoProviderId, Omit<SsoProviderUi, "id">> =
  {
    google: { name: "Google", label: "Continue with Google", Icon: GoogleIcon },
    apple: { name: "Apple", label: "Continue with Apple", Icon: AppleIcon },
    microsoft: {
      name: "Microsoft",
      label: "Continue with Microsoft",
      Icon: MicrosoftIcon,
    },
  };

const SSO_PROVIDER_DISPLAY_ORDER = [
  "google",
  "apple",
  "microsoft",
] as const satisfies readonly SsoProviderId[];

export const SSO_PROVIDERS_UI: readonly SsoProviderUi[] =
  SSO_PROVIDER_DISPLAY_ORDER.map((id) => ({
    id,
    ...SSO_PROVIDER_UI_CONFIG[id],
  }));
