# SKILL: Finance Reporter

## Triggers
Keywords: payment, invoice, expense, income, revenue, bank, balance, transaction, money, price, cost, fee, earning, bill, outstanding, paid, financial, report, budget, profit, loss, monthly, cash flow, bayar, uang, biaya, tagihan, pendapatan, pengeluaran, laporan keuangan

## Data Sources

### Staff Sheet (shared with team)
- **Sheet ID**: `1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw`
- **Tab: Income** — All booking income records
  - Headers at row 7, data from row 8
  - Columns: Date, Guest Name, Villa, Amount, Source (Airbnb/Direct/Booking.com), Payment Method, Status, Notes
- **Tab: Variable Expenses** — One-time operational costs
  - Columns: Date, Villa, Category, Description, Amount, Paid To, Payment Method, Receipt, Notes
- **Tab: Recurring Expenses** — Monthly fixed costs (electricity, wifi, pool, staff)
  - Columns: Date, Villa, Category, Description, Amount, Frequency, Paid To, Notes

### Internal Sheet (owner only — SENSITIVE)
- **Sheet ID**: `1Whlirqo52ve-hMvvllRVLYaUOwAiOTXK6lgCa1xCurQ`
- **Tab: Transactions (Variable)** — Personal expense tracking (EzyPlanners format)
  - Headers at row 6, data from row 7
  - Key columns: J=Description, R=Amount, U=Date, Y=Spender, AS=Category
- **Tab: Transactions (Recurring)** — Recurring income/expenses
  - Headers at row 8, data from row 9
  - Key columns: K=Description, R=Frequency, W=Amount, Z=Date, AF=Member
- ⚠️ **DO NOT WRITE TO**: Monthly tabs, Dashboards, Payment Tracker, Expense/Income Distribution, 50/30/20, Debt Calculator, Savings, Net Worth, Annual Report — these are ALL auto-calculated formulas

### Expenses & Suppliers Sheet
- **Sheet ID**: `1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4`
- Contains supplier details, payment history, contract terms

## Workflow

### Log a Payment (Income)
1. Extract: guest name, villa, amount, source, payment method
2. `finance_log_payment`:
   - guest_name, villa_name, amount, source, payment_method
3. This writes to BOTH Staff Sheet (Income tab) AND Internal Sheet
4. Confirm with formatted receipt

### Log an Expense
1. Extract: villa, category, description, amount, paid to
2. `finance_log_expense`:
   - villa_name, category, description, amount, paid_to, payment_method
3. Writes to Staff Sheet (Variable or Recurring Expenses)
4. Confirm with summary

### Get Financial Report
1. `finance_get_report`:
   - period: "this month" / "last month" / "2026-03" / custom range
   - villa_name: optional filter
2. Report includes: total income, total expenses, net profit, breakdown by villa
3. Format based on audience (detailed for owner, summary for staff)

### Check Outstanding Payments
1. `finance_get_outstanding` → Lists unpaid invoices/bookings
2. Group by villa, sort by date (oldest first)
3. Highlight overdue items

### Generate Invoice
1. `finance_generate_invoice`:
   - guest_name, villa_name, check_in, check_out, amount, extras
2. Returns formatted invoice details

### Bank Balance Check
1. `finance_get_bank_balances` → All accounts
2. Accounts: BCA Main, BCA USD, Wise USD, Wise EUR, PayPal
3. Display with currency and last update date

### Transaction History
1. `finance_get_transactions`:
   - villa_name (optional), date range, type (income/expense/all)
2. List chronologically with running balance context

## Expense Categories
- **Maintenance**: repairs, parts, technician fees
- **Cleaning**: supplies, laundry, deep cleaning
- **Utilities**: electricity (PLN), water (PDAM), internet, gas
- **Staff**: salaries, bonuses, transportation
- **Supplies**: toiletries, kitchen essentials, pool chemicals
- **Marketing**: photography, listing fees, ads
- **Insurance**: property, liability
- **Tax**: PB1, PPh, other government fees
- **Commission**: platform fees (Airbnb 3%, Booking.com 15%)
- **Other**: miscellaneous operational costs

## Response Templates

### WhatsApp — Payment Logged
```
💰 Payment Recorded
Guest: John Smith
Villa: Kala
Amount: Rp 15,000,000
Source: Airbnb
Method: Bank Transfer (BCA)
Date: Mar 27, 2026
Status: PAID ✅
```

### WhatsApp — Expense Logged
```
💸 Expense Recorded
Villa: KALA
Category: Maintenance
Description: AC compressor replacement
Amount: Rp 2,500,000
Paid to: Komang (technician)
Method: Cash
```

### WhatsApp — Monthly Summary (Staff)
```
📊 March 2026 — Financial Summary

Income: Rp 85,000,000
Expenses: Rp 23,400,000
Net: Rp 61,600,000

Top Villas by Revenue:
1. KALA — Rp 30M
2. ANN — Rp 22M
3. DIANE — Rp 18M
4. NISSA — Rp 15M
```

### WhatsApp — Outstanding
```
⚠️ Outstanding Payments

1. Villa LOUNA — Sarah Lee
   Rp 12,000,000 | Due: Mar 15
   14 days overdue

2. Villa ANN — Direct booking (Mike)
   Rp 8,500,000 | Due: Mar 25
   2 days overdue

Total outstanding: Rp 20,500,000
```

## Rules
- Income → write to BOTH Staff Sheet and Internal Sheet
- Expenses → write to Staff Sheet ONLY (Internal Sheet auto-calculates)
- NEVER write to auto-calculated tabs in Internal Sheet
- In group chats: show summary figures only, no individual transaction details
- In private chats with owner: full detail including bank balances
- Always include currency (Rp for IDR, $ for USD, € for EUR)
- Format large numbers with commas: Rp 15,000,000 not Rp 15000000
- When logging maintenance expenses, cross-reference with maintenance_update_task to link the cost
- For monthly reports: compare with previous month and note significant changes (+/- 20%)
- Overdue payments: flag anything >7 days past due date
- All financial data is in WITA timezone (UTC+8)
