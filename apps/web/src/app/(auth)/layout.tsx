export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-gradient-to-br from-brand-700 via-brand-600 to-brand-800 p-10 text-white lg:flex">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 font-bold">T</div>
          <span className="text-lg font-semibold">TherapyOS</span>
        </div>
        <div>
          <h1 className="text-3xl font-semibold leading-tight">Run your entire therapy and wellness business from one platform.</h1>
          <p className="mt-4 max-w-md text-brand-100">
            Customers, appointments, walk-in queues, sessions, billing, packages, memberships, inventory and retention in one
            place.
          </p>
        </div>
        <p className="text-sm text-brand-200">A Rkyves product</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
