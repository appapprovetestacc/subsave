import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";
import { useEffect } from "react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>SubSave</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Phase 3.8 D — frontend error boundary. Posts a redacted error report
// to /qa/error-report on mount; the route forwards to AppApprove via
// captureFrontendError(). Failures are swallowed — the merchant still
// sees the inline fallback either way.
export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error";
  const stack = error instanceof Error ? error.stack : undefined;

  useEffect(() => {
    fetch("/qa/error-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(typeof window !== "undefined" ? { url: window.location.href } : {}),
        ...(stack ? { stack } : {}),
      }),
    }).catch(() => {});
  }, [message, stack]);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>Something went wrong.</h1>
      <p>{message}</p>
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        The error has been reported. Reload the page or contact support if the issue persists.
      </p>
    </main>
  );
}
