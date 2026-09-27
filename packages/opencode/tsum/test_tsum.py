import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tsum.cli import (  # noqa: E402
    filter_columns,
    format_json,
    format_table,
    read_csv_fp,
    summarize,
)

import io  # noqa: E402

PKG_PARENT = Path(__file__).resolve().parent.parent


def run_tsum(*args, input_text=None, cwd=None):
    """Run `python -m tsum` as a subprocess. Returns CompletedProcess."""
    return subprocess.run(
        [sys.executable, "-m", "tsum", *args],
        input=input_text,
        capture_output=True,
        text=True,
        cwd=str(cwd or PKG_PARENT),
    )


def write_csv(path, content):
    path.write_text(content, encoding="utf-8")
    return str(path)


# --- numeric summary ---


def test_numeric_summary_values():
    header = ["age", "score"]
    rows = [["25", "1.5"], ["30", "2.5"], ["22", "3.5"]]
    out = summarize(header, rows)
    assert out[0]["type"] == "numeric"
    assert out[0]["count"] == 3
    assert out[0]["min"] == 22.0
    assert out[0]["max"] == 30.0
    assert out[0]["mean"] == pytest.approx((25 + 30 + 22) / 3)
    assert out[0]["median"] == 25.0
    assert out[1]["median"] == pytest.approx(2.5)


def test_numeric_median_even():
    out = summarize(["x"], [["1"], ["2"], ["3"], ["4"]])
    assert out[0]["median"] == pytest.approx(2.5)


def test_numeric_median_odd():
    out = summarize(["x"], [["3"], ["1"], ["2"]])
    assert out[0]["median"] == pytest.approx(2.0)


def test_rounding_to_3_decimals_in_table_and_json(tmp_path):
    p = write_csv(tmp_path / "a.csv", "x\n1.23456\n2.34567\n")
    proc = run_tsum(str(p))
    assert proc.returncode == 0
    # mean = (1.23456+2.34567)/2 = 1.790115 -> 1.790
    assert "1.235" in proc.stdout  # min rounded
    assert "2.346" in proc.stdout  # max rounded
    assert "1.790" in proc.stdout  # mean rounded

    proc = run_tsum("--json", str(p))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    col = data["columns"][0]
    assert col["min"] == pytest.approx(1.235)
    assert col["max"] == pytest.approx(2.346)
    assert col["mean"] == pytest.approx(1.79, abs=1e-3)


def test_table_lists_all_numeric_fields(tmp_path):
    p = write_csv(tmp_path / "a.csv", "age\n25\n30\n22\n")
    proc = run_tsum(str(p))
    assert proc.returncode == 0
    header_line = proc.stdout.splitlines()[0]
    for token in ["column", "count", "min", "max", "mean", "median"]:
        assert token in header_line
    assert "25.000" in proc.stdout or "25" in proc.stdout


# --- non-numeric columns ---


def test_text_column_count_and_distinct():
    out = summarize(["name"], [["a"], ["b"], ["a"], ["c"]])
    assert out[0]["type"] == "text"
    assert out[0]["count"] == 4
    assert out[0]["distinct"] == 3


def test_mixed_numeric_and_text_is_text():
    out = summarize(["v"], [["1"], ["2"], ["hello"]])
    assert out[0]["type"] == "text"
    assert out[0]["count"] == 3
    assert out[0]["distinct"] == 3


def test_text_output_in_table(tmp_path):
    p = write_csv(tmp_path / "a.csv", "name,age\nalice,30\nbob,25\nalice,22\n")
    proc = run_tsum(str(p))
    assert proc.returncode == 0
    assert "text" in proc.stdout
    assert "numeric" in proc.stdout
    # name column: count 3, distinct 2
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("name")]
    assert len(lines) == 1
    assert "3" in lines[0]
    assert "2" in lines[0]


def test_empty_values_ignored(tmp_path):
    p = write_csv(tmp_path / "a.csv", "x,y\n1,hello\n,world\n3,\n")
    proc = run_tsum("--json", str(p))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    by_name = {c["name"]: c for c in data["columns"]}
    assert by_name["x"]["count"] == 2
    assert by_name["y"]["count"] == 2
    assert by_name["y"]["distinct"] == 2


def test_inf_and_nan_treated_as_text():
    out = summarize(["v"], [["1"], ["inf"]])
    assert out[0]["type"] == "text"
    out = summarize(["v"], [["1"], ["NaN"]])
    assert out[0]["type"] == "text"


# --- --column ---


def test_column_restrict_table(tmp_path):
    p = write_csv(tmp_path / "a.csv", "a,b\n1,x\n2,y\n")
    proc = run_tsum("--column", "b", str(p))
    assert proc.returncode == 0
    assert "b" in proc.stdout
    # column "a" must not appear as a data row
    data_rows = proc.stdout.splitlines()[2:]
    assert all(not r.startswith("a ") and not r.startswith("a  ") for r in data_rows)


def test_column_restrict_json(tmp_path):
    p = write_csv(tmp_path / "a.csv", "a,b\n1,x\n2,y\n")
    proc = run_tsum("--json", "--column", "a", str(p))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert [c["name"] for c in data["columns"]] == ["a"]


def test_column_repeatable(tmp_path):
    p = write_csv(tmp_path / "a.csv", "a,b,c\n1,x,3\n2,y,4\n")
    proc = run_tsum("--json", "--column", "c", "--column", "a", str(p))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert [c["name"] for c in data["columns"]] == ["c", "a"]


def test_column_not_found(tmp_path):
    p = write_csv(tmp_path / "a.csv", "a\n1\n")
    proc = run_tsum("--column", "missing", str(p))
    assert proc.returncode != 0
    assert "column not found" in proc.stderr.lower()


# --- --json ---


def test_json_structure(tmp_path):
    p = write_csv(tmp_path / "a.csv", "age,name\n25,alice\n30,bob\n")
    proc = run_tsum("--json", str(p))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert "columns" in data
    by_name = {c["name"]: c for c in data["columns"]}
    assert by_name["age"]["type"] == "numeric"
    assert by_name["age"]["count"] == 2
    for key in ["min", "max", "mean", "median"]:
        assert key in by_name["age"]
    assert by_name["name"]["type"] == "text"
    assert by_name["name"]["count"] == 2
    assert by_name["name"]["distinct"] == 2


# --- stdin ---


def test_stdin_when_no_file():
    proc = run_tsum(input_text="x\n1\n2\n3\n")
    assert proc.returncode == 0
    assert "x" in proc.stdout
    assert "numeric" in proc.stdout


def test_stdin_json():
    proc = run_tsum("--json", input_text="a,b\n1,x\n2,y\n")
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert len(data["columns"]) == 2


def test_stdin_dash_explicit(tmp_path):
    p = write_csv(tmp_path / "a.csv", "x\n10\n20\n")
    with open(p, encoding="utf-8") as f:
        content = f.read()
    proc = run_tsum("-", input_text=content)
    assert proc.returncode == 0
    assert "numeric" in proc.stdout


# --- multiple files ---


def test_multiple_files_merged(tmp_path):
    p1 = write_csv(tmp_path / "a.csv", "x\n1\n2\n")
    p2 = write_csv(tmp_path / "b.csv", "x\n3\n4\n")
    proc = run_tsum("--json", str(p1), str(p2))
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert data["columns"][0]["count"] == 4
    assert data["columns"][0]["min"] == pytest.approx(1.0)
    assert data["columns"][0]["max"] == pytest.approx(4.0)


def test_header_mismatch_error(tmp_path):
    p1 = write_csv(tmp_path / "a.csv", "x,y\n1,2\n")
    p2 = write_csv(tmp_path / "b.csv", "x,z\n1,2\n")
    proc = run_tsum(str(p1), str(p2))
    assert proc.returncode != 0
    assert "header mismatch" in proc.stderr.lower()


# --- errors ---


def test_missing_file():
    proc = run_tsum("/nonexistent/path/missing.csv")
    assert proc.returncode != 0
    assert "file not found" in proc.stderr.lower()


def test_empty_file(tmp_path):
    p = write_csv(tmp_path / "empty.csv", "")
    proc = run_tsum(str(p))
    assert proc.returncode != 0
    assert "empty file" in proc.stderr.lower()


def test_header_only_file_is_empty(tmp_path):
    p = write_csv(tmp_path / "h.csv", "a,b,c\n")
    proc = run_tsum(str(p))
    assert proc.returncode != 0
    assert "empty file" in proc.stderr.lower() or "no data" in proc.stderr.lower()


def test_ragged_row(tmp_path):
    p = write_csv(tmp_path / "r.csv", "a,b\n1,2\n3\n")
    proc = run_tsum(str(p))
    assert proc.returncode != 0
    assert "ragged" in proc.stderr.lower() or "expected 2 fields" in proc.stderr.lower()


def test_ragged_extra_field(tmp_path):
    p = write_csv(tmp_path / "r.csv", "a,b\n1,2,3\n")
    proc = run_tsum(str(p))
    assert proc.returncode != 0
    assert proc.stderr.strip() != ""


def test_empty_stdin_errors():
    proc = run_tsum(input_text="")
    assert proc.returncode != 0
    assert "empty" in proc.stderr.lower()


# --- unit-level edge cases ---


def test_read_csv_fp_ragged_reports_line_number():
    fp = io.StringIO("a,b\n1,2\n3,4,5\n")
    with pytest.raises(Exception) as excinfo:
        read_csv_fp(fp, "test.csv")
    assert "line 3" in str(excinfo.value)


def test_format_table_headers():
    out = format_table(summarize(["n"], [["1"]]))
    first = out.splitlines()[0]
    for h in ["column", "type", "count", "min", "max", "mean", "median", "distinct"]:
        assert h in first


def test_format_json_rounds():
    s = summarize(["x"], [["1.23456"], ["2.34567"]])
    data = json.loads(format_json(s))
    assert data["columns"][0]["min"] == pytest.approx(1.235)


def test_filter_columns_unknown_raises():
    s = summarize(["a"], [["1"]])
    with pytest.raises(Exception) as excinfo:
        filter_columns(s, ["nope"])
    assert "column not found" in str(excinfo.value).lower()
