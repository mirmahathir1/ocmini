"""tsum: summarize CSV files.

Reads one or more CSV files (or stdin) and prints a summary table:
for every numeric column the count, min, max, mean and median
(rounded to 3 decimals); for non-numeric columns the count and
number of distinct values.

Standard library only.
"""

import argparse
import csv
import json
import math
import sys


class TsumError(Exception):
    """User-facing error with a clear message (exit code 1)."""


def round3(value):
    """Round to 3 decimals, normalizing -0.0 to 0.0."""
    r = round(float(value), 3)
    return 0.0 if r == 0 else r


def fmt3(value):
    """Format a number with exactly 3 decimals, normalizing -0.0."""
    v = float(value)
    if v == 0:
        v = 0.0
    return f"{v:.3f}"


def read_csv_fp(fp, source):
    """Read CSV from an open text file object.

    Returns (header, rows). Raises TsumError on empty input or ragged rows.
    Blank lines (csv returns []) are skipped.
    """
    reader = csv.reader(fp)
    try:
        raw_header = next(reader)
    except StopIteration:
        raise TsumError(f"{source}: empty file")
    # csv returns [] for a leading blank line; treat as empty file.
    if len(raw_header) == 0:
        raise TsumError(f"{source}: empty file")
    header = [h.strip() for h in raw_header]
    if len(header) == 1 and header[0] == "":
        raise TsumError(f"{source}: empty file")
    for h in header:
        if h == "":
            raise TsumError(f"{source}: empty column name in header")
    if len(set(header)) != len(header):
        raise TsumError(f"{source}: duplicate column name in header")

    rows = []
    for lineno, row in enumerate(reader, start=2):
        if len(row) == 0:
            continue  # skip blank lines
        if len(row) != len(header):
            raise TsumError(
                f"{source}: line {lineno}: expected {len(header)} fields "
                f"but got {len(row)} (ragged row)"
            )
        rows.append(row)
    if not rows:
        raise TsumError(f"{source}: empty file (no data rows)")
    return header, rows


def summarize(header, rows):
    """Summarize rows given a header.

    Returns a list of dicts, one per column, preserving header order.
    Numeric column: {"name", "type": "numeric", "count", "min", "max",
                     "mean", "median"} (raw floats, unrounded).
    Text column: {"name", "type": "text", "count", "distinct"}.
    A column is numeric iff it has at least one non-empty value and every
    non-empty value parses as a finite float. Empty strings are treated as
    missing and excluded from counts.
    """
    summaries = []
    for idx, name in enumerate(header):
        values = []
        for row in rows:
            v = row[idx].strip()
            if v == "":
                continue
            values.append(v)
        if not values:
            summaries.append(
                {"name": name, "type": "text", "count": 0, "distinct": 0}
            )
            continue
        nums = []
        is_numeric = True
        for v in values:
            try:
                f = float(v)
            except ValueError:
                is_numeric = False
                break
            if not math.isfinite(f):
                is_numeric = False
                break
            nums.append(f)
        if is_numeric:
            ordered = sorted(nums)
            n = len(ordered)
            if n % 2 == 1:
                median = ordered[n // 2]
            else:
                median = (ordered[n // 2 - 1] + ordered[n // 2]) / 2
            summaries.append(
                {
                    "name": name,
                    "type": "numeric",
                    "count": n,
                    "min": min(ordered),
                    "max": max(ordered),
                    "mean": sum(ordered) / n,
                    "median": median,
                }
            )
        else:
            summaries.append(
                {
                    "name": name,
                    "type": "text",
                    "count": len(values),
                    "distinct": len(set(values)),
                }
            )
    return summaries


def filter_columns(summaries, wanted):
    """Restrict summaries to wanted column names (deduped, requested order)."""
    by_name = {s["name"]: s for s in summaries}
    seen = set()
    ordered = []
    for name in wanted:
        if name in seen:
            continue
        seen.add(name)
        if name not in by_name:
            raise TsumError(f"column not found: {name!r}")
        ordered.append(by_name[name])
    return ordered


def format_table(summaries):
    """Render summaries as a padded plain-text table."""
    headers = ["column", "type", "count", "min", "max", "mean", "median", "distinct"]
    lines = []
    for s in summaries:
        if s["type"] == "numeric":
            lines.append(
                [
                    s["name"],
                    "numeric",
                    str(s["count"]),
                    fmt3(s["min"]),
                    fmt3(s["max"]),
                    fmt3(s["mean"]),
                    fmt3(s["median"]),
                    "",
                ]
            )
        else:
            lines.append(
                [
                    s["name"],
                    "text",
                    str(s["count"]),
                    "",
                    "",
                    "",
                    "",
                    str(s["distinct"]),
                ]
            )
    widths = [len(h) for h in headers]
    for row in lines:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    out = []
    out.append("  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)).rstrip())
    out.append(
        "  ".join("-" * widths[i] for i in range(len(headers))).rstrip()
    )
    for row in lines:
        out.append(
            "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        )
    return "\n".join(out) + "\n"


def format_json(summaries):
    """Render summaries as machine-readable JSON (numbers rounded to 3)."""
    cols = []
    for s in summaries:
        if s["type"] == "numeric":
            cols.append(
                {
                    "name": s["name"],
                    "type": "numeric",
                    "count": s["count"],
                    "min": round3(s["min"]),
                    "max": round3(s["max"]),
                    "mean": round3(s["mean"]),
                    "median": round3(s["median"]),
                }
            )
        else:
            cols.append(
                {
                    "name": s["name"],
                    "type": "text",
                    "count": s["count"],
                    "distinct": s["distinct"],
                }
            )
    return json.dumps({"columns": cols}, indent=2) + "\n"


def build_parser():
    parser = argparse.ArgumentParser(
        prog="tsum",
        description=(
            "Summarize CSV files: numeric columns show count/min/max/mean/median, "
            "text columns show count/distinct."
        ),
    )
    parser.add_argument(
        "files",
        metavar="FILE",
        nargs="*",
        help="CSV file(s) to summarize. Reads stdin when omitted. Use '-' for stdin.",
    )
    parser.add_argument(
        "--column",
        dest="columns",
        action="append",
        default=None,
        metavar="NAME",
        help="Restrict output to column NAME (repeatable).",
    )
    parser.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="Print machine-readable JSON instead of a table.",
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        header = None
        rows = []
        if not args.files:
            h, r = read_csv_fp(sys.stdin, "<stdin>")
            header, rows = h, r
        else:
            for path in args.files:
                if path == "-":
                    h, r = read_csv_fp(sys.stdin, "<stdin>")
                    source = "<stdin>"
                else:
                    source = path
                    try:
                        with open(path, "r", newline="", encoding="utf-8-sig") as f:
                            h, r = read_csv_fp(f, source)
                    except FileNotFoundError:
                        print(f"tsum: error: file not found: {path}", file=sys.stderr)
                        return 1
                    except IsADirectoryError:
                        print(
                            f"tsum: error: not a file (is a directory): {path}",
                            file=sys.stderr,
                        )
                        return 1
                    except OSError as exc:
                        print(
                            f"tsum: error: cannot read {path}: {exc}",
                            file=sys.stderr,
                        )
                        return 1
                if header is None:
                    header = h
                    rows = list(r)
                else:
                    if h != header:
                        print(
                            f"tsum: error: {source}: header mismatch: "
                            f"expected {header} but got {h}",
                            file=sys.stderr,
                        )
                        return 1
                    rows.extend(r)

        summaries = summarize(header, rows)
        if args.columns:
            summaries = filter_columns(summaries, args.columns)

        if args.as_json:
            sys.stdout.write(format_json(summaries))
        else:
            sys.stdout.write(format_table(summaries))
        return 0
    except TsumError as exc:
        print(f"tsum: error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 1
