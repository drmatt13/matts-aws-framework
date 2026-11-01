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

function FacebookIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
      <path
        fill="#1877F2"
        d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"
      />
    </svg>
  );
}

const SSO_PROVIDER_UI_CONFIG: Record<SsoProviderId, Omit<SsoProviderUi, "id">> =
  {
    google: { name: "Google", label: "Continue with Google", Icon: GoogleIcon },
    microsoft: {
      name: "Microsoft",
      label: "Continue with Microsoft",
      Icon: MicrosoftIcon,
    },
    // Meta's sign-in is Facebook Login, and its button says so.
    meta: {
      name: "Facebook",
      label: "Continue with Facebook",
      Icon: FacebookIcon,
    },
  };

const SSO_PROVIDER_DISPLAY_ORDER = [
  "google",
  "microsoft",
  "meta",
] as const satisfies readonly SsoProviderId[];

export const SSO_PROVIDERS_UI: readonly SsoProviderUi[] =
  SSO_PROVIDER_DISPLAY_ORDER.map((id) => ({
    id,
    ...SSO_PROVIDER_UI_CONFIG[id],
  }));
