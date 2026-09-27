# tsum

`tsum` is a small Python CLI (standard library only) that reads one or more CSV
files and prints a summary table.

- Numeric columns: `count`, `min`, `max`, `mean`, `median` (rounded to 3 decimals).
- Non-numeric columns: `count` and number of distinct values (`distinct`).
- A column is numeric if every non-empty value parses as a finite float.
  Empty strings are treated as missing and excluded from counts. `NaN`/`Inf`
  make a column non-numeric.

## Run

From the directory containing the `tsum/` folder:

```bash
python -m tsum data.csv
python -m tsum a.csv b.csv
cat data.csv | python -m tsum
python -m tsum --column age data.csv
python -m tsum --json data.csv
```

No third-party dependencies. Python 3.8+.

## Examples

Given `example.csv`:

```csv
name,age,score
alice,30,9.5
bob,25,8.25
alice,22,7.0
```

Table output:

```bash
$ python -m tsum example.csv
column  type     count  min     max     mean    median  distinct
------  -------  -----  -----   -----   -----   ------  --------
name    text     3                                            2
age     numeric  3      22.000  30.000  25.667  25.000
score   numeric  3      7.000   9.500   8.250   8.250
```

Restrict to one column:

```bash
$ python -m tsum --column age example.csv
column  type     count  min     max     mean    median  distinct
------  -------  -----  -----   -----   -----   ------  --------
age     numeric  3      22.000  30.000  25.667  25.000
```

Repeat `--column` for several columns (output follows the requested order):

```bash
$ python -m tsum --column score --column age example.csv
```

Machine-readable JSON:

```bash
$ python -m tsum --json example.csv
{
  "columns": [
    {
      "name": "name",
      "type": "text",
      "count": 3,
      "distinct": 2
    },
    {
      "name": "age",
      "type": "numeric",
      "count": 3,
      "min": 22.0,
      "max": 30.0,
      "mean": 25.667,
      "median": 25.0
    }
  ]
}
```

Combine with `--column`:

```bash
$ python -m tsum --json --column age example.csv
```

Read from stdin (no file argument, or explicit `-`):

```bash
$ cat example.csv | python -m tsum
$ cat example.csv | python -m tsum -
$ python -m tsum a.csv - < extra.csv
```

Multiple files are merged. All files must share the same header (same names,
same order):

```bash
$ python -m tsum jan.csv feb.csv
```

## Errors (non-zero exit)

All errors print `tsum: error: ...` to stderr and exit with status 1:

| Case | Example message |
|------|-----------------|
| Missing file | `tsum: error: file not found: nope.csv` |
| Empty file / header only / empty stdin | `tsum: error: empty.csv: empty file (no data rows)` |
| Ragged row | `tsum: error: data.csv: line 3: expected 2 fields but got 1 (ragged row)` |
| Header mismatch | `tsum: error: feb.csv: header mismatch: expected ['a'] but got ['b']` |
| Unknown `--column` | `tsum: error: column not found: 'height'` |

```bash
$ python -m tsum missing.csv; echo $?
tsum: error: file not found: missing.csv
1
```

## Tests

```bash
pytest tsum/test_tsum.py -v
# or from inside tsum/:
pytest -v
```
