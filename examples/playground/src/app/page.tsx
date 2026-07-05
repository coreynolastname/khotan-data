export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Khotan Data Playground
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Local generated app</h1>
      </div>
      <a className="text-blue-700 underline" href="/config">
        Open Khotan config UI
      </a>
    </main>
  );
}
