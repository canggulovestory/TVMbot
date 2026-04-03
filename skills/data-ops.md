# SKILL: Data Operations (Sheets, Drive, Reports)

## Triggers
Keywords: sheet, spreadsheet, data, report, lookup, search file, drive, folder, document, contract, upload, download, pdf, table, tab, row, column, find file, organize, convert, merge, villa info, supplier, bills, cari file, cari data, laporan

## Architecture (replicated from AutoGPT airtable/http blocks + crewAI task execution)
Follows AutoGPT block pattern for structured data operations:
- Input schema validation → Data fetch → Transform → Output
- Supports: read, write, append, search, aggregate operations
- Multi-sheet awareness: knows which sheet/tab holds what data

## Sheet Directory

### Master Expenses Sheet
- ID: `1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4`
- EXPENSES tab → expense records (from Google Form + manual)
- VILLAS_MASTER tab → villa directory (18 columns: code, name, address, internet, electricity, etc.)
- SUPPLIERS_MASTER tab → vendor contacts + bank details
- RECURRING_SETUP tab → monthly bill config
- BILLS_DB tab → monthly bills tracker (paid/unpaid)
- DASHBOARD_2026 tab → summary dashboard
- LISTS tab → dropdown values
- CONTROL tab → settings

### Staff Sheet
- ID: `1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw`
- Income tab → booking income records
- Variable Expenses tab → one-time costs
- Recurring Expenses tab → monthly fixed costs

### Internal Sheet (Owner Only)
- ID: `1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ`
- Transactions (Variable) → personal expense tracking
- Transactions (Recurring) → recurring income/expenses
- ⚠️ DO NOT WRITE to auto-calculated tabs

### Maintenance Sheet
- ID: `1sYq5iMKqu4xTBhLIddgRMDVgB6wdN7Jy2Qvrn-uM_ZE`
- MAINTENANCE tab → current tasks
- 2025 MAINTENANCE → archive
- MAINTENANCE ULUWATU → Uluwatu properties
- PERIODICAL MAINTENANCE SCHEDULE → recurring maintenance

## Workflow

### Read Data (QUERY)
Input: what to look up, optional filters
1. Identify correct sheet + tab from query context
2. `sheets_read_data` with spreadsheetId and range
3. Parse and filter results
4. Format for user (table or summary)
Output: Formatted data

### Write Data (MODIFY)
Input: what to update, new values
Validation: ALWAYS read first, never overwrite formulas
1. `sheets_read_data` → check current state
2. Verify target cells don't contain formulas
3. `sheets_write_data` or `sheets_append_row`
4. Confirm what was written
Output: Write confirmation

### Search Files (SEARCH)
Input: file name, type, or content keywords
1. `drive_search_files` with query
2. Return matching files with links
Output: File list with names, types, dates

### Generate Report (AGGREGATE)
Input: report type, date range, filters
1. Read relevant sheets
2. Aggregate data (sum, count, average, group)
3. Format as structured report
Output: Report text or data table

## Common Queries Map

| User asks about... | Sheet | Tab | Key columns |
|---|---|---|---|
| Villa info, address, internet | Master | VILLAS_MASTER | All 18 cols |
| Supplier contact, bank details | Master | SUPPLIERS_MASTER | Name, Phone, Bank |
| Monthly bills, paid/unpaid | Master | BILLS_DB | Status, Amount, Due |
| Expense records | Master | EXPENSES | Date, Villa, Amount |
| Booking income | Staff | Income | Guest, Villa, Amount |
| Recurring costs | Staff | Recurring Expenses | Category, Amount |
| Maintenance tasks | Maintenance | MAINTENANCE | Villa, Issue, Status |
| Guest contract | Drive | Search | contract + guest name |
| Passport scan | Drive | Search | passport + guest name |

## Google Drive Operations
- Search: `drive_search_files` (name, type, folder)
- Find passport: `drive_find_passport` (by guest name)
- Recent files: `drive_get_recent`
- Create folder: `drive_create_folder`
- Read document: `drive_read_contract` (PDF/DOCX content)
- Scan folder: `drive_scan_folder` (list contents)

## Response Templates

### Data Lookup
```
📊 Villa Info — KALA

Address: Jl. Pantai Batu Bolong, Canggu
Bedrooms: 3
Internet: GlobalXtreme (afnih9G43A)
Plan: 50 Mbps — Rp 650,000/mo
Pool Guy: Komang
Status: Active
```

### Bills Summary
```
📋 March 2026 Bills

✅ Paid (12):
  Internet: 6 villas — Rp 3,900,000
  Electricity: 4 villas — Rp 2,800,000

⏳ Pending (5):
  KALA — Trash collector — Rp 150,000
  LOUNA — Pool maintenance — Rp 400,000
  ANN — Banjar fee — Rp 500,000
  DIANE — Laundry — Rp 350,000
  NISSA — Security — Rp 300,000

Total paid: Rp 6,700,000
Total pending: Rp 1,700,000
```

### File Search
```
📁 Search Results: "contract kala"

1. 📄 Villa Kala — John Smith Contract.pdf
   Modified: Mar 15, 2026

2. 📄 Villa Kala — Rental Agreement Template.docx
   Modified: Feb 20, 2026

2 files found
```

## Rules
- ALWAYS read before write — check for formulas
- Use correct spreadsheet ID for each query
- EXPENSES tab uses Google Form auto-population — append only, don't modify existing rows
- Staff Sheet is shared with team — keep data clean
- Internal Sheet is owner-only — never reference in group chats
- For large datasets (>50 rows), summarize instead of listing all
- When searching Drive, try multiple query variations if first search returns nothing
