/** Pantalla centrada para /login y /signup. Sin sesión, sin datos. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 items-center justify-center px-6 py-16">{children}</div>;
}
