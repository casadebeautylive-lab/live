/** Shown instantly while a page's data loads, so navigation never feels frozen. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-[1400px] animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-56 rounded-lg bg-panel-2" />
      <div className="card h-44" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card h-24" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card h-64" />
        <div className="card h-64" />
      </div>
    </div>
  );
}
