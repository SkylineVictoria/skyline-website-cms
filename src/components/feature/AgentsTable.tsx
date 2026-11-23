import { useMemo, useState } from "react";
import { registeredAgentsPage } from "@/data/pages";
import SearchableSelect from "@/components/ui/SearchableSelect";

const tableBlock = registeredAgentsPage.blocks.find((block) => block.type === "table");
const columns = tableBlock && tableBlock.type === "table" ? tableBlock.columns : [];
const allRows = tableBlock && tableBlock.type === "table" ? tableBlock.rows : [];

const PAGE_SIZES = [15, 25, 50];

export default function AgentsTable() {
  const [sortAsc, setSortAsc] = useState(true);
  const [pageSize, setPageSize] = useState(15);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const rows = [...allRows];
    rows.sort((a, b) => {
      const nameA = (a[0] ?? "").toLowerCase();
      const nameB = (b[0] ?? "").toLowerCase();
      return sortAsc ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
    });
    return rows;
  }, [sortAsc]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const changePage = (next: number) => {
    setPage(Math.min(Math.max(1, next), totalPages));
  };

  return (
    <div className="rounded-card border border-background-200 bg-background-50">
      <div className="flex flex-col gap-4 border-b border-background-200 p-4 md:flex-row md:items-center md:justify-between md:p-5">
        <p className="text-sm text-foreground-600">
          Showing <strong className="font-semibold text-foreground-950">{pageRows.length}</strong> of{" "}
          <strong className="font-semibold text-foreground-950">{sorted.length}</strong> registered agents
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setSortAsc((value) => !value);
              setPage(1);
            }}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-sm font-medium text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
          >
            <i className="ri-sort-asc text-base" aria-hidden="true" />
            Name: {sortAsc ? "A–Z" : "Z–A"}
          </button>
          <label className="flex items-center gap-2 text-sm text-foreground-600">
            Show
            <SearchableSelect
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              className="rounded-md border border-background-300 bg-background-50 px-2.5 py-2 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </SearchableSelect>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead>
            <tr className="bg-secondary-100">
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 font-label text-xs font-semibold uppercase tracking-wider text-secondary-900"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rowIndex) => (
              <tr key={`${row[0]}-${rowIndex}`} className="border-t border-background-200 align-top">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={`px-4 py-3 text-foreground-700 ${
                      cellIndex === 0 ? "font-medium text-foreground-950" : ""
                    } ${cellIndex === 2 ? "whitespace-nowrap tabular-nums" : ""}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-background-200 p-4 sm:flex-row md:px-5">
          <button
            type="button"
            onClick={() => changePage(safePage - 1)}
            disabled={safePage <= 1}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-sm font-medium text-foreground-800 transition-colors hover:border-primary-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <i className="ri-arrow-left-s-line text-base" aria-hidden="true" />
            Previous
          </button>
          <p className="text-sm text-foreground-600">
            Page <strong className="font-semibold text-foreground-950">{safePage}</strong> of {totalPages}
          </p>
          <button
            type="button"
            onClick={() => changePage(safePage + 1)}
            disabled={safePage >= totalPages}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-sm font-medium text-foreground-800 transition-colors hover:border-primary-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
            <i className="ri-arrow-right-s-line text-base" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}