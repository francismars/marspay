import type { StepConversionStep } from '../../lib/api';

export function RateBars({
  rows,
  active,
  onSelect,
}: {
  rows: Array<{ id: string; label: string; rate: number; detail: string }>;
  active?: string;
  onSelect?: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No games in this window yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const width = Math.max(row.rate > 0 ? 2 : 0, Math.min(100, row.rate));
        const selected = active === row.id;
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={onSelect ? () => onSelect(row.id) : undefined}
              className={`w-full rounded-lg px-3 py-2 text-left ${
                selected ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'
              }`}
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                <span className={selected ? 'text-zinc-100' : 'text-zinc-300'}>{row.label}</span>
                <span className="tabular-nums text-zinc-400">
                  <span className="text-zinc-100">{row.rate}%</span>
                  <span className="ml-2 text-xs">{row.detail}</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function FunnelBars({
  steps,
  biggestDropIndex,
  onStepClick,
}: {
  steps: StepConversionStep[];
  biggestDropIndex: number;
  onStepClick?: (step: StepConversionStep) => void;
}) {
  if (steps.length === 0) {
    return <p className="text-sm text-zinc-500">No path data in this window yet.</p>;
  }
  const max = Math.max(...steps.map((s) => s.count), 1);

  return (
    <ol className="space-y-3">
      {steps.map((step, i) => {
        const leak = i === biggestDropIndex && i > 0 && step.dropFromPrevious > 0;
        const width = Math.max(step.count > 0 ? 2 : 0, (step.count / max) * 100);
        return (
          <li key={step.key}>
            <button
              type="button"
              onClick={onStepClick ? () => onStepClick(step) : undefined}
              className="w-full text-left"
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="text-zinc-200">{step.label}</span>
                <span className="tabular-nums text-zinc-400">
                  {step.count.toLocaleString()}
                  {i > 0 ? <span className="ml-2 text-xs">{step.pctOfPrevious}% kept</span> : null}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full rounded-full ${leak ? 'bg-amber-400' : 'bg-accent'}`}
                  style={{ width: `${width}%` }}
                />
              </div>
              {leak ? (
                <p className="mt-1 text-xs text-amber-300">
                  Biggest leak: {step.dropFromPrevious}% do not reach this step.
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function CountBars({
  rows,
  empty,
}: {
  rows: Array<{ label: string; count: number }>;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">{empty}</p>;
  }
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div>
            <div className="mb-1 truncate text-sm text-zinc-300">{row.label}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-accent-purple"
                style={{ width: `${Math.max(row.count > 0 ? 4 : 0, (row.count / max) * 100)}%` }}
              />
            </div>
          </div>
          <span className="tabular-nums text-sm text-zinc-400">{row.count.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
